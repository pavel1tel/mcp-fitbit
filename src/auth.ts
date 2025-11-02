import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import http from 'http';
import open from 'open';
import path from 'path';
import { AuthorizationCode, Token } from 'simple-oauth2';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import pkg from 'pg';
const { Pool } = pkg;
import { FITBIT_OAUTH_CONFIG } from './config.js';

// TypeScript interfaces for token data structures
// The Token interface from simple-oauth2 uses this structure
interface FitbitTokenData extends Token {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: string;
  scope: string;
  token_type: string;
  user_id: string;
}

interface FitbitOAuthErrorBody {
  // Structure of the error object returned by Fitbit API.
  // This is a placeholder. Update with specific fields if an example
  // of a Fitbit API error response becomes available.
  [key: string]: unknown;
}

interface FitbitOAuthError extends Error {
  message: string;
  response?: {
    text: () => Promise<string>;
    status?: number;
    body?: FitbitOAuthErrorBody; // More specific body
  };
  // simple-oauth2 might add other properties like 'context'
  context?: unknown; 
}

// Determine the directory of the current module (build/auth.js)
const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

// Load environment variables from .env file located in the project root
const envPath = path.resolve(currentDirname, '..', '.env');
dotenv.config({ path: envPath });

// Fitbit OAuth2 Configuration
const fitbitConfig = {
  client: {
    id: process.env.FITBIT_CLIENT_ID || '',
    secret: process.env.FITBIT_CLIENT_SECRET || '',
  },
  auth: {
    tokenHost: 'https://api.fitbit.com',
    authorizePath: 'https://www.fitbit.com/oauth2/authorize',
    tokenPath: 'https://api.fitbit.com/oauth2/token',
  },
  options: {
    authorizationMethod: 'header' as const,
  },
};

// PostgreSQL Database Configuration
const DATABASE_URL = process.env.DATABASE_URL || '';
const dbPool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Required for Railway PostgreSQL
  },
});

// OAuth2 Redirect URI and local server port
const REDIRECT_URI = 'http://localhost:3000/callback';
const PORT = 3000;

// --- State Management ---
// Storage for the access token and token data
let accessToken: string | null = null;
let tokenData: FitbitTokenData | null = null;
// Holds the temporary HTTP server instance used for the OAuth callback
let oauthServer: http.Server | null = null;

// --- File paths for token persistence (keeping for backward compatibility) ---
const TOKEN_FILE_PATH = path.resolve(
  currentDirname,
  '..',
  '.fitbit-token.json'
);

// --- Database initialization ---
/**
 * Initializes the database table for storing Fitbit tokens
 */
async function initializeDatabase(): Promise<void> {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS fitbit_token (
        id INTEGER PRIMARY KEY DEFAULT 1,
        token_data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_token_row CHECK (id = 1)
      );
    `;
    await dbPool.query(createTableQuery);
    console.error('Database table initialized successfully');
  } catch (error) {
    console.error('Error initializing database table:', error);
    throw error;
  }
}

// --- OAuth Client Initialization ---
const oauthClient = new AuthorizationCode(fitbitConfig);

/**
 * Saves the token data to the database
 * @param tokenData The token data to save
 */
async function saveTokenToDB(tokenData: FitbitTokenData): Promise<void> {
  try {
    const upsertQuery = `
      INSERT INTO fitbit_token (id, token_data, updated_at)
      VALUES (1, $1, CURRENT_TIMESTAMP)
      ON CONFLICT (id)
      DO UPDATE SET
        token_data = EXCLUDED.token_data,
        updated_at = CURRENT_TIMESTAMP;
    `;
    await dbPool.query(upsertQuery, [JSON.stringify(tokenData)]);
    console.error('Token saved to database successfully');
  } catch (error) {
    console.error(`Error saving token to database: ${error}`);
    throw error;
  }
}

/**
 * Loads the token data from the database
 * @returns The token data or null if not found
 */
async function loadTokenFromDB(): Promise<FitbitTokenData | null> {
  try {
    const selectQuery = 'SELECT token_data FROM fitbit_token WHERE id = 1;';
    const result = await dbPool.query(selectQuery);

    if (result.rows.length === 0) {
      console.error('No token found in database');
      return null;
    }

    const rawTokenData = result.rows[0].token_data;

    // The pg library automatically parses JSON columns, so check if it's already an object
    const tokenData = typeof rawTokenData === 'string'
      ? JSON.parse(rawTokenData)
      : rawTokenData as FitbitTokenData;

    console.error('Token loaded from database successfully');
    return tokenData;
  } catch (error) {
    console.error(`Error loading token from database: ${error}`);
    return null;
  }
}

// --- Fitbit Authorization Flow ---

/**
 * Initiates the Fitbit OAuth2 authorization code flow.
 * Starts a temporary local web server to handle the redirect callback.
 * Opens the user's browser to the Fitbit authorization page.
 */
export function startAuthorizationFlow(): void {
  // Prevent multiple authorization flows from running simultaneously
  if (oauthServer) {
    console.error('OAuth server is already running.');
    return;
  }
  // Ensure Client ID and Secret are loaded before starting
  if (!fitbitConfig.client.id || !fitbitConfig.client.secret) {
    console.error(
      'Error: Fitbit Client ID or Secret not found. Check environment variables.'
    );
    return;
  }

  const app = express();

  // Generate the Fitbit authorization URL
  const authorizationUri = oauthClient.authorizeURL({
    redirect_uri: REDIRECT_URI,
    // Define necessary scopes required by the application
    scope: FITBIT_OAUTH_CONFIG.SCOPES,
  });

  // Route to initiate the authorization flow by redirecting the user to Fitbit
  app.get('/auth', (req: Request, res: Response) => {
    console.error('Redirecting to Fitbit for authorization...');
    res.redirect(authorizationUri);
  });

  // Callback route that Fitbit redirects to after user authorization
  app.get('/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string;
    // Handle cases where the authorization code is missing
    if (!code) {
      console.error('Authorization code missing in callback.');
      res.status(400).send('Error: Authorization code missing.');
      // Attempt to close the server if it exists
      if (oauthServer) {
        oauthServer.close(() => {
          console.error('OAuth server closed due to missing code.');
        });
        oauthServer = null;
      }
      return;
    }

    console.error('Received authorization code. Exchanging for token...');
    const tokenParams = { code: code, redirect_uri: REDIRECT_URI };

    try {
      // Exchange the authorization code for an access token
      const tokenResult = await oauthClient.getToken(tokenParams);
      console.error('Access Token received successfully!');
      accessToken = tokenResult.token.access_token as string;
      tokenData = tokenResult.token as FitbitTokenData;

      // Persist token data to database
      if (tokenData) {
        await saveTokenToDB(tokenData);
        console.error('Token data has been persisted to database');
      }

      res.send(
        'Authorization successful! You can close this window. The MCP Server is now authenticated.'
      );
    } catch (error: unknown) { 
      // Handle errors during token exchange
      const typedError = error as FitbitOAuthError; 
      console.error('Error obtaining access token:', typedError.message || typedError);
      if (typedError.response) {
        try {
          const errorDetails = await typedError.response.text();
          console.error('Error details:', errorDetails);
          // Optionally parse errorDetails if it's JSON and log typedError.response.body
        } catch {
          console.error('Could not parse error response body.');
        }
      }
      res
        .status(500)
        .send('Error obtaining access token. Check MCP server logs.');
    } finally {
      // Ensure the temporary server is always shut down after handling the callback
      if (oauthServer) {
        console.error('Shutting down temporary OAuth server...');
        oauthServer.close(() => {
          console.error('OAuth server closed.');
          oauthServer = null;
        });
      }
    }
  });

  // Start the temporary local server
  oauthServer = app.listen(PORT, async () => {
    const authUrl = `http://localhost:${PORT}/auth`;
    console.error(
      `--------------------------------------------------------------------`
    );
    console.error(`ACTION REQUIRED: Fitbit Authorization Needed`);
    console.error(`Attempting to open authorization page in your browser:`);
    console.error(authUrl);
    console.error(
      `If the browser doesn't open, please navigate there manually.`
    );
    console.error(`Waiting for authorization callback...`);
    console.error(
      `--------------------------------------------------------------------`
    );
    // Attempt to automatically open the authorization URL in the default browser
    try {
      await open(authUrl);
      console.error(`Browser opened (or attempted).`);
    } catch (err) {
      console.error(`Failed to open browser automatically:`, err);
    }
  });

  // Handle potential errors during server startup
  oauthServer.on('error', (err) => {
    console.error('Error starting temporary OAuth server:', err);
    oauthServer = null;
  });
}

/**
 * Retrieves the current Fitbit access token.
 * Automatically checks for token expiry and refreshes if necessary.
 * @returns The access token string or null if not available.
 */
export async function getAccessToken(): Promise<string | null> {
  // Return null if no token data exists
  if (!tokenData || !accessToken) {
    console.error('No valid access token found.'); // Added missing console.error and fixed surrounding logic
    return null;
  }

  // Check if token is expired
  if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
    console.error('Token is expired. Attempting to refresh...');
    try {
      // Create AccessToken instance from the current token data
      // FitbitTokenData is compatible with the 'Token' type expected by createToken
      const accessTokenObj = oauthClient.createToken(tokenData);

      // Refresh the token
      if (accessTokenObj.expired()) {
        const refreshedToken = await accessTokenObj.refresh();
        accessToken = refreshedToken.token.access_token as string;
        tokenData = refreshedToken.token as FitbitTokenData;

        // Save the refreshed token
        await saveTokenToDB(tokenData);
        console.error('Token refreshed and saved successfully.');
        return accessToken;
      }
    } catch (refreshError) {
      console.error('Failed to refresh token:', refreshError);
      accessToken = null;
      tokenData = null;
      return null;
    }
  }

  return accessToken;
}

/**
 * Initializes the authentication module.
 * Loads persisted token from database storage if available.
 */
export async function initializeAuth(): Promise<void> {
  console.error('Auth initialized. Initializing database and checking for persisted token...');

  try {
    // Initialize database table
    await initializeDatabase();

    // Load token data from database
    tokenData = await loadTokenFromDB();

    if (tokenData && tokenData.access_token) {
      accessToken = tokenData.access_token;
      console.error('Persisted access token loaded successfully.');

      // Check if token is expired and needs refresh
      if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
        console.error('Token is expired. Attempting to refresh...');
        try {
          // Create AccessToken instance from the loaded token data
          // FitbitTokenData is compatible with the 'Token' type expected by createToken
          const accessTokenObj = oauthClient.createToken(tokenData);

          // Refresh the token
          if (accessTokenObj.expired()) {
            const refreshedToken = await accessTokenObj.refresh();
            accessToken = refreshedToken.token.access_token as string;
            tokenData = refreshedToken.token as FitbitTokenData;

            // Save the refreshed token
            if (tokenData) {
              await saveTokenToDB(tokenData);
              console.error('Refreshed token saved successfully.');
            }
          }
        } catch (refreshError) {
          console.error('Error refreshing token:', refreshError);
          accessToken = null;
          tokenData = null;
        }
      }
    } else {
      console.error('No valid access token found.');
    }
  } catch (error) {
    console.error('Error during token initialization:', error);
  }
}
