import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "../docs/openapi.js";

export const docsRouter = Router();

// Raw OpenAPI JSON (for tooling and the UI below).
docsRouter.get("/", (_req, res) => {
  res.json(openApiDocument);
});

// Serve the exact /api-docs/ui URL without the static middleware's slash redirect.
docsRouter.get("/ui", swaggerUi.setup(openApiDocument));

// Swagger UI rendered from the same document (serves /ui and /ui/).
docsRouter.use("/ui", swaggerUi.serve, swaggerUi.setup(openApiDocument));