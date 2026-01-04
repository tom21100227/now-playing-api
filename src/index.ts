import { SignJWT, importPKCS8 } from 'jose';
import { KVNamespace } from '@cloudflare/workers-types';

// Define the shape of our environment variables
export interface Env {
	SPOTIFY_CLIENT_ID: string;
	SPOTIFY_CLIENT_SECRET: string;
	SPOTIFY_REFRESH_TOKEN: string;
	APPLE_TEAM_ID: string;
	APPLE_KEY_ID: string;
	APPLE_PRIVATE_KEY: string;
	APPLE_MUSIC_USER_TOKEN: string;
	RESULT_CACHE: KVNamespace;
	APPLE_STATE_CACHE: KVNamespace;
}

// API endpoints
const SPOTIFY_NOW_PLAYING_ENDPOINT = `https://api.spotify.com/v1/me/player/currently-playing`;
const SPOTIFY_RECENT_ENDPOINT = `https://api.spotify.com/v1/me/player/recently-played`;
const SPOTIFY_TOKEN_ENDPOINT = `https://accounts.spotify.com/api/token`;
const APPLE_RECENTLY_PLAYED_ENDPOINT = `https://api.music.apple.com/v1/me/recent/played/tracks?limit=1`;

// Cache Configuration
const DEFAULT_CACHE_TTL = 120; // Default cache TTL in seconds
const MAX_CACHE_TTL = 600; // Maximum cache TTL in seconds (10 minutes)

// HTTP Status Codes
const HTTP_NO_CONTENT = 204; // Spotify returns this when nothing is playing
const HTTP_OK = 200; // Standard OK response
const HTTP_UNAUTHORIZED = 401; // Unauthorized response

// / Time Constants
const MILLISECONDS_PER_SECOND = 1000;
const APPLE_TOKEN_EXPIRY = '1h';

// Image Dimensions
const ALBUM_IMAGE_WIDTH = '500';
const ALBUM_IMAGE_HEIGHT = '500';

// Cache Keys
const NOW_PLAYING_CACHE_KEY = 'now_playing_result';
const APPLE_SONG_CACHE_KEY = 'last_apple_song';

// URL Parameters
const NO_CACHE_PARAM = 'noCache';
const NO_CACHE_VALUE = 'true';

// JWT Configuration
const JWT_ALGORITHM = 'ES256';

interface ApiResponse {
	success: boolean;
	isPlaying: boolean;
	timeStamp: string;
	source?: string;
	duration?: number; // Duration in milliseconds
	title?: string;
	artist?: string;
	album?: string;
	albumImageUrl?: string;
	songUrl?: string;
	error?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// If the request specified cache=false, skip the cache
		if (new URL(request.url).searchParams.get(NO_CACHE_PARAM) === NO_CACHE_VALUE) {
			console.log('Cache bypassed due to request parameter.');
			env.RESULT_CACHE.delete(NOW_PLAYING_CACHE_KEY);
		} else {
			// Check if there is a cached result first
			const cachedResult = await env.RESULT_CACHE.get(NOW_PLAYING_CACHE_KEY, { type: 'json' });

			if (cachedResult) {
				return new Response(JSON.stringify(cachedResult, null, 2), {
					headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'HIT', 'Access-Control-Allow-Origin': '*' },
				});
			}
		}

		const appleMusicUserToken = env.APPLE_MUSIC_USER_TOKEN;

		// Run both API calls in parallel
		const [spotify, apple]: [ApiResponse, ApiResponse] = await Promise.all([
			getSpotifyData(env),
			getAppleMusicData(env, appleMusicUserToken),
		]);

		let responseData;
		if (spotify.isPlaying) {
			console.log('Returning Spotify data (is playing):', spotify.title);
			responseData = spotify;
		} else if (apple.isPlaying) {
			console.log('Returning Apple Music data (is playing):', apple.title);
			responseData = apple;
		} else {
			// Compare timestamps to find the most recent
			const spotifyTime = spotify.timeStamp ? new Date(spotify.timeStamp).getTime() : 0;
			const appleTime = apple.timeStamp ? new Date(apple.timeStamp).getTime() : 0;
			responseData = spotifyTime >= appleTime ? spotify : apple;
			console.info('Apple Music Played (Cached) at', apple.timeStamp, '\n Spotify Played at', spotify.timeStamp);
			if (spotifyTime < appleTime) {
				console.log('Returning Apple Music data (more recent):', apple.title);
			} else {
				console.log('Returning Spotify data (more recent):', spotify.title);
			}
		}

		if (responseData.success) {
			ctx.waitUntil(
				// Cache the result with a TTL based on the duration of the song, or a default of 120 seconds. TTL is capped at 600 seconds (10 minutes).
				env.RESULT_CACHE.put(NOW_PLAYING_CACHE_KEY, JSON.stringify(responseData), {
					expirationTtl:
						responseData.duration != null ? Math.min(Math.floor(responseData.duration / 1000), MAX_CACHE_TTL) : DEFAULT_CACHE_TTL,
				}),
			);
		}

		return new Response(JSON.stringify(responseData, null, 2), {
			headers: { 'Content-Type': 'application/json', 'X-Cache-Status': 'MISS', 'Access-Control-Allow-Origin': '*' },
		});
	},
};

// --- SPOTIFY HELPER FUNCTIONS ---
async function getSpotifyData(env: Env) {
	const accessToken = await getAccessToken(env);
	if (!accessToken) {
		console.error('Spotify: Could not get access token.');
		return { success: false, isPlaying: false, timeStamp: new Date().toISOString(), error: 'Could not get access token for Spotify.' };
	}

	let spotifynowPlaying: ApiResponse = await getNowPlaying(accessToken);
	if (spotifynowPlaying.title) {
		return spotifynowPlaying;
	}

	console.info('Now Playing endpoint did not return any data. Trying Recently Played endpoint.');

	let newAccessToken = await getAccessToken(env);
	if (!newAccessToken) {
		console.error('Spotify: Could not get access token.');
		return { success: false, isPlaying: false, timeStamp: new Date().toISOString(), error: 'Could not get access token for Spotify.' };
	}

	let recentlyPlayed: ApiResponse = await getSpotifyRecentlyPlayed(newAccessToken);
	return recentlyPlayed;
}

/**
 * Uses the refresh token to get a short-lived access token from Spotify.
 */
async function getAccessToken(env: Env) {
	// btoa() creates a Base64-encoded string, which is required by Spotify.
	const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

	const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: env.SPOTIFY_REFRESH_TOKEN,
		}),
	});

	const data: { access_token?: string } = await response.json();
	return data.access_token;
}

/**
 * Fetches the currently playing track from Spotify using an access token.
 */
async function getNowPlaying(accessToken: string) {
	const response = await fetch(SPOTIFY_NOW_PLAYING_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	// If nothing is playing, Spotify returns a 204 No Content response.
	if (response.status === HTTP_NO_CONTENT) {
		console.log('Spotify: No track is currently playing.');
		return { success: true, isPlaying: false, timeStamp: new Date(0).toISOString() };
	}
	// If the response is not OK, we return an error.
	if (!response.ok) {
		console.error('Spotify API Error:', response.status, response.statusText);
		return {
			success: false,
			isPlaying: false,
			timeStamp: new Date().toISOString(),
			error: `Failed to fetch from Spotify. Status: ${response.status} ${response.statusText}`,
		};
	}

	const song: any = await response.json();

	// We are structuring the response to only include the data we care about.
	console.log('Spotify: Query Successful, currently playing:', song.item.name);
	return {
		success: true,
		source: 'Spotify',
		timeStamp: new Date(song.timestamp).toISOString(),
		duration: song.item.duration_ms, // Duration in milliseconds
		isPlaying: song.is_playing,
		title: song.item.name,
		artist: song.item.artists.map((_artist: any) => _artist.name).join(', '),
		album: song.item.album.name,
		albumImageUrl: song.item.album.images[0].url,
		songUrl: song.item.external_urls.spotify,
	};
}

async function getSpotifyRecentlyPlayed(accessToken: string) {
	const response = await fetch(SPOTIFY_RECENT_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});

	if (!response.ok) {
		console.error('Spotify Recently Played: Query Failed');
		return {
			success: false,
			isPlaying: false,
			timeStamp: new Date().toISOString(),
			error: `Failed to fetch from Spotify. Status: ${response.status} ${response.statusText}`,
		};
	}

	const songs: any = await response.json();

	const mostRecent = songs.items[0];

	// We are structuring the response to only include the data we care about.
	console.log('Spotify: Query Successful, recently playing:', mostRecent.track.name);
	return {
		success: true,
		source: 'Spotify',
		timeStamp: new Date(mostRecent.played_at).toISOString(),
		duration: mostRecent.track.duration_ms, // Duration in milliseconds
		isPlaying: false,
		title: mostRecent.track.name,
		artist: mostRecent.track.artists.map((_artist: any) => _artist.name).join(', '),
		album: mostRecent.track.album.name,
		albumImageUrl: mostRecent.track.album.images[0].url,
		songUrl: mostRecent.track.external_urls.spotify,
	};
}

/**
 * Generates a short-lived Developer Token to talk to the Apple Music API.
 */
async function getAppleDeveloperToken(env: Env) {
	try {
		const privateKey = await importPKCS8(env.APPLE_PRIVATE_KEY, JWT_ALGORITHM);
		const alg = JWT_ALGORITHM;

		const jwt = await new SignJWT({})
			.setProtectedHeader({
				alg,
				kid: env.APPLE_KEY_ID, // Your Key ID
			})
			.setIssuedAt()
			.setIssuer(env.APPLE_TEAM_ID) // Your Team ID
			.setExpirationTime(APPLE_TOKEN_EXPIRY); // Token is valid for 1 hour

		return jwt.sign(privateKey);
	} catch (err) {
		console.error('Apple Music Token Generation Error:', err);
		return null;
	}
}

interface AppleCacheState {
	songId: string;
	cachedAt: number; // Timestamp
}

async function getAppleMusicData(env: Env, musicUserToken: string) {
	const developerToken = await getAppleDeveloperToken(env);
	if (!developerToken || !musicUserToken) {
		return { success: false, isPlaying: false, timeStamp: new Date().toISOString(), error: 'Could not generate Apple Developer Token.' };
	}

	try {
		const response = await fetch(APPLE_RECENTLY_PLAYED_ENDPOINT, {
			headers: {
				Authorization: `Bearer ${developerToken}`,
				'Music-User-Token': musicUserToken,
			},
		});

		if (response.status > HTTP_NO_CONTENT || !response.body) {
			const errorBody = await response.text().catch(() => 'Could not read response body');
			console.error(`Apple Music API Error: ${response.status} ${response.statusText}`, errorBody);
			return {
				isPlaying: false,
				timeStamp: new Date().toISOString(),
				success: false,
				error: `Failed to fetch from Apple Music. Status: ${response.status} ${response.statusText}`,
			};
		}

		const { data }: any = await response.json();
		const lastSong = data[0];
		const songId = lastSong.id;

		const durationInMillis = lastSong.attributes.durationInMillis;

		const cachedState: AppleCacheState | null = await env.APPLE_STATE_CACHE.get(APPLE_SONG_CACHE_KEY, { type: 'json' });

		const oneSongAgo = Date.now() - durationInMillis;

		// If the current song is the same one we have in cache, it could be old.
		if (cachedState && cachedState.songId === songId) {
			if (cachedState.cachedAt > oneSongAgo) {
				// The cached song is being played live, return with isLive = true
				console.log('Apple Music: Using cached song (playing):', lastSong.attributes.name);
				return formatAppleSong(lastSong, true, cachedState.cachedAt);
			} else {
				// The cached song is not being played live, return with isLive = false
				console.log(
					'Apple Music: Determined that the cached song is not being played live: Time Now: ',
					Date.now(),
					'Cached At:',
					cachedState.cachedAt,
					'One Song Ago:',
					oneSongAgo,
				);
				console.log('Apple Music: Using cached song (not playing):', lastSong.attributes.name);
				return formatAppleSong(lastSong, false, cachedState.cachedAt);
			}
		} else {
			// There's a new song, so we update the cache with the new song ID and current timestamp.
			console.log('Apple Music: New song detected, updating cache:', lastSong.attributes.name);
			const newState: AppleCacheState = { songId: songId, cachedAt: Date.now() };
			await env.APPLE_STATE_CACHE.put(APPLE_SONG_CACHE_KEY, JSON.stringify(newState));
			return formatAppleSong(lastSong, true, Date.now());
		}
	} catch (error) {
		console.error('Apple Music API Error:', error);
		return {
			success: false,
			isPlaying: false,
			timeStamp: new Date().toISOString(),
			error: 'Failed to fetch from Apple Music. Is the User Token valid?',
		};
	}
}

function formatAppleSong(song: any, isLive: boolean, timestamp: number) {
	return {
		success: true,
		source: 'Apple Music',
		timeStamp: new Date(timestamp).toISOString(),
		isPlaying: isLive, // We still say true, but the 'isLive' flag gives more context.
		duration: song.attributes.durationInMillis, // Duration in milliseconds
		title: song.attributes.name,
		artist: song.attributes.artistName,
		album: song.attributes.albumName,
		albumImageUrl: song.attributes.artwork.url.replace('{w}', ALBUM_IMAGE_WIDTH).replace('{h}', ALBUM_IMAGE_HEIGHT),
		songUrl: song.attributes.url,
	};
}
