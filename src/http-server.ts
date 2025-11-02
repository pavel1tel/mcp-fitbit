#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Import authentication functions
import {
  initializeAuth,
  startAuthorizationFlow,
  getAccessToken,
} from './auth.js';
// Import tool registration function(s)
import { registerWeightTool } from './weight.js';
import { registerSleepTool } from './sleep.js';
import { registerProfileTool } from './profile.js';
import { registerActivitiesTool } from './activities.js';
import { registerHeartRateTools } from './heart-rate.js';
import { registerNutritionTools } from './nutrition.js';
import { registerDailyActivityTool } from './daily-activity.js';
import { registerActivityGoalsTool } from './activity-goals.js';
import { registerActivityTimeSeriesTool } from './activity-timeseries.js';
import { registerAzmTimeSeriesTool } from './azm-timeseries.js';
// Import utilities
import './utils.js';

// Calculate the directory name of the current module (build/http-server.js)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Construct the absolute path to the .env file (one level up from build/)
// Load environment variables early in the application lifecycle
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

// Validate required environment variables
function validateEnvironment(): void {
  const requiredVars = {
    FITBIT_CLIENT_ID: process.env.FITBIT_CLIENT_ID,
    FITBIT_CLIENT_SECRET: process.env.FITBIT_CLIENT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };

  const missingVars = Object.entries(requiredVars)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingVars.length > 0) {
    console.error('Missing required environment variables:');
    missingVars.forEach(varName => {
      console.error(`   - ${varName}`);
    });
    console.error(`Please create a .env file at: ${envPath}`);
    console.error('See README.md for details on getting Fitbit API credentials.');
    process.exit(1);
  }
}

// Validate environment before proceeding
validateEnvironment();

// Log successful environment loading
console.error('✅ Environment variables loaded successfully');

const app = express();
app.use(express.json());

// Create the MCP server once (can be reused across requests)
const server = new McpServer({
  name: 'fitbit',
  version: '1.0.0',
  capabilities: {
    resources: {},
    tools: {}, // Tools are registered dynamically below
  },
});

// Register available tools with the MCP server
registerWeightTool(server, getAccessToken);
registerSleepTool(server, getAccessToken);
registerProfileTool(server, getAccessToken);
registerActivitiesTool(server, getAccessToken);
registerHeartRateTools(server, getAccessToken);
registerNutritionTools(server, getAccessToken);
registerDailyActivityTool(server, getAccessToken);
registerActivityGoalsTool(server, getAccessToken);
registerActivityTimeSeriesTool(server, getAccessToken);
registerAzmTimeSeriesTool(server, getAccessToken);

app.post('/mcp', async (req, res) => {
  // In stateless mode, create a new transport for each request to prevent
  // request ID collisions. Different clients may use the same JSON-RPC request IDs,
  // which would cause responses to be routed to the wrong HTTP connections if
  // the transport state is shared.

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });

    res.on('close', () => {
      transport.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});

async function main() {
  // Initialize the authentication module (e.g., load persisted token)
  await initializeAuth();

  const port = parseInt(process.env.PORT || '3000');

  const httpServer = app.listen(port, () => {
    console.log(`MCP Fitbit Server running on http://localhost:${port}/mcp`);
  }).on('error', error => {
    console.error('Server error:', error);
    process.exit(1);
  });

  // Check if an access token is available after server starts
  // If not, initiate the OAuth2 authorization flow
  const token = await getAccessToken();
  if (!token) {
    console.error(
      'No access token found. Starting Fitbit authorization flow...'
    );
    startAuthorizationFlow(); // Start flow in background, do not await
  } else {
    console.error('Using existing/loaded access token.');
  }

  console.error('HTTP MCP Server setup complete. Waiting for requests...');

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.error('Shutting down HTTP server...');
    httpServer.close(() => {
      console.error('HTTP server closed.');
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.error('Shutting down HTTP server...');
    httpServer.close(() => {
      console.error('HTTP server closed.');
      process.exit(0);
    });
  });
}

// Execute the main function and handle any top-level errors
main().catch((error: Error) => {
  console.error(
    'Fatal error during MCP server startup:',
    error.message || error
  );
  process.exit(1);
});
