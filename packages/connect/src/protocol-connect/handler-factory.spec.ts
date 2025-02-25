// Copyright 2021-2023 Buf Technologies, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { MethodInfo, ServiceType } from "@bufbuild/protobuf";
import {
  Int32Value,
  MethodIdempotency,
  MethodKind,
  StringValue,
} from "@bufbuild/protobuf";
import { createHandlerFactory } from "./handler-factory.js";
import type { MethodImpl } from "../implementation.js";
import { createMethodImplSpec } from "../implementation.js";
import type {
  UniversalHandlerOptions,
  UniversalServerResponse,
} from "../protocol/index.js";
import {
  createAsyncIterable,
  createUniversalHandlerClient,
  encodeEnvelope,
  pipeTo,
  readAllBytes,
  sinkAll,
  transformSplitEnvelope,
} from "../protocol/index.js";
import { Code, ConnectError } from "../index.js";
import { errorFromJsonBytes } from "./error-json.js";
import { endStreamFromJson } from "./end-stream.js";
import { createTransport } from "./transport.js";
import { requestHeader } from "./request-header.js";

describe("createHandlerFactory()", function () {
  const testService = {
    typeName: "TestService",
    methods: {
      unary: {
        name: "Unary",
        I: Int32Value,
        O: StringValue,
        kind: MethodKind.Unary,
      },
      unaryNoSideEffects: {
        name: "UnaryNoSideEffects",
        I: Int32Value,
        O: StringValue,
        kind: MethodKind.Unary,
        idempotency: MethodIdempotency.NoSideEffects,
      },
      serverStreaming: {
        name: "ServerStreaming",
        I: Int32Value,
        O: StringValue,
        kind: MethodKind.ServerStreaming,
      },
    },
  } satisfies ServiceType;

  function setupTestHandler<M extends MethodInfo>(
    method: M,
    opt: Partial<UniversalHandlerOptions>,
    impl: MethodImpl<M>
  ) {
    const h = createHandlerFactory(opt)(
      createMethodImplSpec(testService, method, impl)
    );
    const t = createTransport({
      httpClient: createUniversalHandlerClient([h]),
      baseUrl: "https://example.com",
      readMaxBytes: 0xffffff,
      writeMaxBytes: 0xffffff,
      compressMinBytes: 0xffffff,
      useBinaryFormat: true,
      interceptors: [],
      acceptCompression: [],
      sendCompression: null,
    });
    return {
      service: testService,
      method: method,
      handler: h,
      transport: t,
    };
  }

  describe("returned handler", function () {
    it("should allow POST for unary RPC", function () {
      const { handler } = setupTestHandler(testService.methods.unary, {}, () =>
        Promise.reject()
      );
      expect(handler.allowedMethods).toEqual(["POST"]);
      expect(handler.protocolNames).toEqual(["connect"]);
    });
    it("should allow GET,POST for eligible RPC", function () {
      const { handler } = setupTestHandler(
        testService.methods.unaryNoSideEffects,
        {},
        () => Promise.reject()
      );
      expect(handler.allowedMethods).toEqual(["POST", "GET"]);
      expect(handler.protocolNames).toEqual(["connect"]);
    });
    it("should surface headers for unary", async function () {
      const { transport, service, method } = setupTestHandler(
        testService.methods.unary,
        {},
        (req, ctx) => {
          ctx.responseHeader.set("implementation-called", "yes");
          return { value: req.value.toString(10) };
        }
      );
      const r = await transport.unary(
        service,
        method,
        undefined,
        undefined,
        undefined,
        new Int32Value({ value: 123 })
      );
      expect(r.header.get("implementation-called")).toBe("yes");
      expect(r.message.value).toBe("123");
    });

    it("should surface headers for server-streaming", async function () {
      const { transport, service, method } = setupTestHandler(
        testService.methods.serverStreaming,
        {},
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* (req, ctx) {
          ctx.responseHeader.set("implementation-called", "yes");
          yield { value: req.value.toString(10) };
        }
      );
      const r = await transport.stream(
        service,
        method,
        undefined,
        undefined,
        undefined,
        createAsyncIterable([new Int32Value({ value: 123 })])
      );
      expect(r.header.get("implementation-called")).toBe("yes");
      const all = await pipeTo(r.message, sinkAll());
      expect(all.length).toBe(1);
      expect(all[0].value).toBe("123");
    });
  });

  describe("requireConnectProtocolHeader", function () {
    describe("with unary RPC", function () {
      const { handler } = setupTestHandler(
        testService.methods.unary,
        { requireConnectProtocolHeader: true },
        (req) => ({ value: req.value.toString(10) })
      );
      it("should raise error for missing header", async function () {
        const res = await handler({
          httpVersion: "1.1",
          method: "POST",
          url: new URL("https://example.com"),
          header: new Headers({ "Content-Type": "application/json" }),
          body: 777,
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(400);
        expect(res.body).toBeInstanceOf(Uint8Array);
        if (res.body instanceof Uint8Array) {
          const err = errorFromJsonBytes(
            res.body,
            undefined,
            new ConnectError("failed to parse connect err", Code.Internal)
          );
          expect(err.message).toBe(
            '[invalid_argument] missing required header: set Connect-Protocol-Version to "1"'
          );
        }
      });
      it("should raise error for wrong header", async function () {
        const res = await handler({
          httpVersion: "1.1",
          method: "POST",
          url: new URL("https://example.com"),
          header: new Headers({
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "UNEXPECTED",
          }),
          body: 777,
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(400);
        expect(res.body).toBeInstanceOf(Uint8Array);
        if (res.body instanceof Uint8Array) {
          const err = errorFromJsonBytes(
            res.body,
            undefined,
            new ConnectError("failed to parse connect err", Code.Internal)
          );
          expect(err.message).toBe(
            '[invalid_argument] Connect-Protocol-Version must be "1": got "UNEXPECTED"'
          );
        }
      });
    });
    describe("with streaming RPC", function () {
      const { handler } = setupTestHandler(
        testService.methods.serverStreaming,
        { requireConnectProtocolHeader: true },
        // eslint-disable-next-line @typescript-eslint/require-await
        async function* (req) {
          yield { value: req.value.toString(10) };
        }
      );
      it("should raise error for missing header", async function () {
        const res = await handler({
          httpVersion: "1.1",
          method: "POST",
          url: new URL("https://example.com"),
          header: new Headers({ "Content-Type": "application/connect+json" }),
          body: createAsyncIterable([new Uint8Array()]),
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(200);
        expect(res.body).not.toBeInstanceOf(Uint8Array);
        expect(res.body).not.toBeUndefined();
        if (res.body !== undefined && Symbol.asyncIterator in res.body) {
          const end = endStreamFromJson(
            (await readAllBytes(res.body, Number.MAX_SAFE_INTEGER)).slice(5)
          );
          expect(end.error?.message).toBe(
            '[invalid_argument] missing required header: set Connect-Protocol-Version to "1"'
          );
        }
      });
      it("should raise error for wrong header", async function () {
        const res = await handler({
          httpVersion: "1.1",
          method: "POST",
          url: new URL("https://example.com"),
          header: new Headers({
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "UNEXPECTED",
          }),
          body: createAsyncIterable([new Uint8Array()]),
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(200);
        expect(res.body).not.toBeInstanceOf(Uint8Array);
        expect(res.body).not.toBeUndefined();
        if (res.body !== undefined && Symbol.asyncIterator in res.body) {
          const end = endStreamFromJson(
            (await readAllBytes(res.body, Number.MAX_SAFE_INTEGER)).slice(5)
          );
          expect(end.error?.message).toBe(
            '[invalid_argument] Connect-Protocol-Version must be "1": got "UNEXPECTED"'
          );
        }
      });
    });
  });

  describe("deadlines", function () {
    describe("with unary RPC", function () {
      it("should raise an error with code DEADLINE_EXCEEDED if exceeded", async function () {
        const timeoutMs = 1;
        const { handler, service, method } = setupTestHandler(
          testService.methods.unary,
          {},
          async (req, ctx) => {
            await new Promise((r) => setTimeout(r, timeoutMs + 50));
            ctx.signal.throwIfAborted();
            return { value: req.value.toString(10) };
          }
        );
        const res = await handler({
          httpVersion: "2.0",
          method: "POST",
          url: new URL(
            `https://example.com/${service.typeName}/${method.name}`
          ),
          header: requestHeader(method.kind, true, timeoutMs, undefined),
          body: createAsyncIterable([new Uint8Array(0)]),
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(408);
        expect(res.body).toBeDefined();
        if (res.body !== undefined) {
          const bodyBytes =
            res.body instanceof Uint8Array
              ? res.body
              : await readAllBytes(res.body, Number.MAX_SAFE_INTEGER);
          const err = errorFromJsonBytes(
            bodyBytes,
            undefined,
            new ConnectError("error parse failed")
          );
          expect(err.code).toBe(Code.DeadlineExceeded);
          expect(err.message).toBe(
            "[deadline_exceeded] the operation timed out"
          );
        }
      });
    });
    describe("with streaming RPC", function () {
      async function getLastEnvelope(res: UniversalServerResponse) {
        expect(res.body).toBeDefined();
        expect(res.body).not.toBeInstanceOf(Uint8Array);
        if (res.body !== undefined && Symbol.asyncIterator in res.body) {
          const envelopes = await pipeTo(
            res.body,
            transformSplitEnvelope(0xffffff),
            sinkAll()
          );
          const last = envelopes.pop();
          expect(last).toBeDefined();
          return last;
        }
        return undefined;
      }

      it("should raise an error with code DEADLINE_EXCEEDED if exceeded", async function () {
        const timeoutMs = 1;
        const { handler, service, method } = setupTestHandler(
          testService.methods.serverStreaming,
          {},
          async function* (req, ctx) {
            await new Promise((r) => setTimeout(r, timeoutMs + 50));
            ctx.signal.throwIfAborted();
            yield { value: req.value.toString(10) };
          }
        );
        const res = await handler({
          httpVersion: "2.0",
          method: "POST",
          url: new URL(
            `https://example.com/${service.typeName}/${method.name}`
          ),
          header: requestHeader(method.kind, true, timeoutMs, undefined),
          body: createAsyncIterable([encodeEnvelope(0, new Uint8Array(0))]),
          signal: new AbortController().signal,
        });
        expect(res.status).toBe(200);
        expect(res.body).toBeDefined();
        if (res.body !== undefined) {
          const lastEnv = await getLastEnvelope(res);
          if (lastEnv !== undefined) {
            const end = endStreamFromJson(lastEnv.data);
            expect(end.error?.code).toBe(Code.DeadlineExceeded);
            expect(end.error?.message).toBe(
              "[deadline_exceeded] the operation timed out"
            );
          }
        }
      });
    });
  });

  describe("request abort signal", function () {
    describe("with unary RPC", function () {
      it("should trigger handler context signal", async function () {
        let handlerContextSignal: AbortSignal | undefined;
        const { handler, service, method } = setupTestHandler(
          testService.methods.unary,
          {},
          async (req, ctx) => {
            handlerContextSignal = ctx.signal;
            for (;;) {
              await new Promise((r) => setTimeout(r, 1));
              ctx.signal.throwIfAborted();
            }
          }
        );
        const ac = new AbortController();
        const resPromise = handler({
          httpVersion: "2.0",
          method: "POST",
          url: new URL(
            `https://example.com/${service.typeName}/${method.name}`
          ),
          header: requestHeader(method.kind, true, undefined, undefined),
          body: createAsyncIterable([new Uint8Array(0)]),
          signal: ac.signal,
        });
        ac.abort("test-reason");
        await resPromise;
        expect(handlerContextSignal).toBeDefined();
        expect(handlerContextSignal?.aborted).toBeTrue();
        expect(handlerContextSignal?.reason).toBe("test-reason");
      });
    });
    describe("with streaming RPC", function () {
      it("should trigger handler context signal", async function () {
        let handlerContextSignal: AbortSignal | undefined;
        const { handler, service, method } = setupTestHandler(
          testService.methods.serverStreaming,
          {},
          // eslint-disable-next-line require-yield
          async function* (req, ctx) {
            handlerContextSignal = ctx.signal;
            for (;;) {
              await new Promise((r) => setTimeout(r, 1));
              ctx.signal.throwIfAborted();
            }
          }
        );
        const ac = new AbortController();
        const resPromise = handler({
          httpVersion: "2.0",
          method: "POST",
          url: new URL(
            `https://example.com/${service.typeName}/${method.name}`
          ),
          header: requestHeader(method.kind, true, undefined, undefined),
          body: createAsyncIterable([encodeEnvelope(0, new Uint8Array(0))]),
          signal: ac.signal,
        });
        ac.abort("test-reason");
        await resPromise;
        expect(handlerContextSignal).toBeDefined();
        expect(handlerContextSignal?.aborted).toBeTrue();
        expect(handlerContextSignal?.reason).toBe("test-reason");
      });
    });
  });

  describe("GET requests", function () {
    it("should be accepted for eligible RPC", async function () {
      const { handler, service, method } = setupTestHandler(
        testService.methods.unaryNoSideEffects,
        {},
        // eslint-disable-next-line @typescript-eslint/require-await
        async (req, ctx) => {
          expect(ctx.requestMethod).toBe("GET");
          expect(ctx.protocolName).toBe("connect");
          return { value: "abc" };
        }
      );
      const res = await handler({
        httpVersion: "2.0",
        method: "GET",
        url: new URL(
          `https://example.com/${service.typeName}/${method.name}?connect=v1&encoding=proto&base64=1&message=CHs`
        ),
        header: new Headers(),
        body: createAsyncIterable([]),
        signal: new AbortController().signal,
      });
      expect(res.status).toBe(200);
    });
  });
});
