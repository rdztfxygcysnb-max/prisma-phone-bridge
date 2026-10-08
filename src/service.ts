import { type } from "arktype";
import { secretString } from "@prisma/composer/arktype";
import node from "@prisma/composer/node";
import { compute } from "@prisma/composer-prisma-cloud";

export default compute({
  name: "web",
  deps: {},
  input: type({
    mcpAuthToken: secretString(),
  }),
  build: node({ module: import.meta.url, entry: "../dist/server.mjs" }),
});
