# @johnhenry/aimatey-http

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-http.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-http)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-http.svg)](LICENSE)

> **Note:** Previously published as `aimatey-http@0.3.1`.

HTTP framework adapters for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-http
```

## Overview

This package provides HTTP framework integrations for serving Aimatey bridges as API endpoints. Supports multiple popular Node.js and edge frameworks.

## Included Adapters

- **Express** - Express.js middleware
- **Fastify** - Fastify handler
- **Hono** - Hono middleware (works on edge)
- **Koa** - Koa middleware
- **Node** - Native Node.js HTTP handler
- **Deno** - Deno HTTP handler

For core HTTP utilities (auth, CORS, rate limiting), see [`@johnhenry/aimatey-http-core`](https://www.npmjs.com/package/@johnhenry/aimatey-http-core).

## Usage

### Express

```typescript
import express from 'express';
import { ExpressMiddleware } from '@johnhenry/aimatey-http';
import { Bridge } from '@johnhenry/aimatey-core';

const app = express();
const bridge = new Bridge(frontend, backend);

const middleware = new ExpressMiddleware({ bridge });
app.post('/v1/chat/completions', middleware.handler());
```

### Fastify

```typescript
import Fastify from 'fastify';
import { FastifyHandler } from '@johnhenry/aimatey-http';

const fastify = Fastify();
const handler = new FastifyHandler({ bridge });

fastify.post('/v1/chat/completions', handler.handler());
```

### Hono

```typescript
import { Hono } from 'hono';
import { HonoMiddleware } from '@johnhenry/aimatey-http';

const app = new Hono();
const middleware = new HonoMiddleware({ bridge });

app.post('/v1/chat/completions', middleware.handler());
```

### Node.js Native HTTP

```typescript
import http from 'http';
import { NodeHTTPListener } from '@johnhenry/aimatey-http';

const listener = new NodeHTTPListener({ bridge });
const server = http.createServer(listener.handler());
```

### Deno

```typescript
import { DenoHandler } from '@johnhenry/aimatey-http';

const handler = new DenoHandler({ bridge });
Deno.serve(handler.handler());
```

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
