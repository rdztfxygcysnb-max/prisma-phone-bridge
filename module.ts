import { module } from "@prisma/composer";
import { envSecret } from "@prisma/composer-prisma-cloud";
import webService from "./src/service.ts";

export default module("phone-bridge", ({ provision }) => {
  provision(webService, {
    input: { mcpAuthToken: envSecret("MCP_AUTH_TOKEN") },
  });
});
