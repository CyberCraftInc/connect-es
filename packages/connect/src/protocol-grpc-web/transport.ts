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

import type {
  AnyMessage,
  Message,
  MethodInfo,
  PartialMessage,
  ServiceType,
} from "@bufbuild/protobuf";
import type {
  StreamRequest,
  StreamResponse,
  Transport,
  UnaryRequest,
  UnaryResponse,
} from "../index.js";
import { Code, ConnectError, runStreaming, runUnary } from "../index.js";
import type { CommonTransportOptions } from "../protocol/index.js";
import {
  createAsyncIterable,
  createLinkedAbortController,
  createMethodSerializationLookup,
  createMethodUrl,
  pipe,
  pipeTo,
  transformCatchFinally,
  transformCompressEnvelope,
  transformDecompressEnvelope,
  transformJoinEnvelopes,
  transformNormalizeMessage,
  transformParseEnvelope,
  transformSerializeEnvelope,
  transformSplitEnvelope,
} from "../protocol/index.js";
import { validateTrailer } from "../protocol-grpc/validate-trailer.js";
import { requestHeaderWithCompression } from "./request-header.js";
import { validateResponseWithCompression } from "./validate-response.js";
import { createTrailerSerialization, trailerFlag } from "./trailer.js";

/**
 * Create a Transport for the gRPC-web protocol.
 */
export function createTransport(opt: CommonTransportOptions): Transport {
  return {
    async unary<
      I extends Message<I> = AnyMessage,
      O extends Message<O> = AnyMessage
    >(
      service: ServiceType,
      method: MethodInfo<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      message: PartialMessage<I>
    ): Promise<UnaryResponse<I, O>> {
      const serialization = createMethodSerializationLookup(
        method,
        opt.binaryOptions,
        opt.jsonOptions,
        opt
      );
      const ac = createLinkedAbortController(signal);
      return await runUnary<I, O>(
        {
          stream: false,
          service,
          method,
          url: createMethodUrl(opt.baseUrl, service, method),
          init: {},
          header: requestHeaderWithCompression(
            opt.useBinaryFormat,
            timeoutMs,
            header,
            opt.acceptCompression,
            opt.sendCompression
          ),
          message:
            message instanceof method.I ? message : new method.I(message),
          signal: ac.signal,
        },
        async (req: UnaryRequest<I, O>): Promise<UnaryResponse<I, O>> => {
          const uRes = await opt.httpClient({
            url: req.url,
            method: "POST",
            header: req.header,
            signal: req.signal,
            body: pipe(
              createAsyncIterable([req.message]),
              transformSerializeEnvelope(
                serialization.getI(opt.useBinaryFormat)
              ),
              transformCompressEnvelope(
                opt.sendCompression,
                opt.compressMinBytes
              ),
              transformJoinEnvelopes(),
              {
                propagateDownStreamError: true,
              }
            ),
          });
          try {
            const { compression } = validateResponseWithCompression(
              opt.useBinaryFormat,
              opt.acceptCompression,
              uRes.status,
              uRes.header
            );
            const { trailer, message } = await pipeTo(
              uRes.body,
              transformSplitEnvelope(opt.readMaxBytes),
              transformDecompressEnvelope(
                compression ?? null,
                opt.readMaxBytes
              ),
              transformParseEnvelope<O, Headers>(
                serialization.getO(opt.useBinaryFormat),
                trailerFlag,
                createTrailerSerialization()
              ),
              async (iterable) => {
                let message: O | undefined;
                let trailer: Headers | undefined;
                for await (const env of iterable) {
                  if (env.end) {
                    if (trailer !== undefined) {
                      throw new ConnectError(
                        "protocol error: received extra trailer",
                        Code.InvalidArgument
                      );
                    }
                    trailer = env.value;
                  } else {
                    if (message !== undefined) {
                      throw new ConnectError(
                        "protocol error: received extra output message for unary method",
                        Code.InvalidArgument
                      );
                    }
                    message = env.value;
                  }
                }
                return { trailer, message };
              },
              {
                propagateDownStreamError: false,
              }
            );
            if (trailer === undefined) {
              throw new ConnectError(
                "protocol error: missing trailer",
                Code.InvalidArgument
              );
            }
            validateTrailer(trailer);
            if (message === undefined) {
              throw new ConnectError(
                "protocol error: missing output message for unary method",
                Code.InvalidArgument
              );
            }
            return <UnaryResponse<I, O>>{
              stream: false,
              service,
              method,
              header: uRes.header,
              message,
              trailer,
            };
          } catch (e) {
            ac.abort(e);
            throw e;
          }
        },
        opt.interceptors
      );
    },
    async stream<
      I extends Message<I> = AnyMessage,
      O extends Message<O> = AnyMessage
    >(
      service: ServiceType,
      method: MethodInfo<I, O>,
      signal: AbortSignal | undefined,
      timeoutMs: number | undefined,
      header: HeadersInit | undefined,
      input: AsyncIterable<I>
    ): Promise<StreamResponse<I, O>> {
      const serialization = createMethodSerializationLookup(
        method,
        opt.binaryOptions,
        opt.jsonOptions,
        opt
      );
      const ac = createLinkedAbortController(signal);
      return runStreaming<I, O>(
        {
          stream: true,
          service,
          method,
          url: createMethodUrl(opt.baseUrl, service, method),
          init: {
            method: "POST",
            redirect: "error",
            mode: "cors",
          },
          signal: ac.signal,
          header: requestHeaderWithCompression(
            opt.useBinaryFormat,
            timeoutMs,
            header,
            opt.acceptCompression,
            opt.sendCompression
          ),
          message: pipe(input, transformNormalizeMessage(method.I), {
            propagateDownStreamError: true,
          }),
        },
        async (req: StreamRequest<I, O>) => {
          const uRes = await opt.httpClient({
            url: req.url,
            method: "POST",
            header: req.header,
            signal: req.signal,
            body: pipe(
              req.message,
              transformNormalizeMessage(method.I),
              transformSerializeEnvelope(
                serialization.getI(opt.useBinaryFormat)
              ),
              transformCompressEnvelope(
                opt.sendCompression,
                opt.compressMinBytes
              ),
              transformJoinEnvelopes(),
              { propagateDownStreamError: true }
            ),
          });
          try {
            const { compression, foundStatus } =
              validateResponseWithCompression(
                opt.useBinaryFormat,
                opt.acceptCompression,
                uRes.status,
                uRes.header
              );
            const res: StreamResponse<I, O> = {
              ...req,
              header: uRes.header,
              trailer: new Headers(),
              message: pipe(
                uRes.body,
                transformSplitEnvelope(opt.readMaxBytes),
                transformDecompressEnvelope(
                  compression ?? null,
                  opt.readMaxBytes
                ),
                transformParseEnvelope(
                  serialization.getO(opt.useBinaryFormat),
                  trailerFlag,
                  createTrailerSerialization()
                ),
                async function* (iterable) {
                  if (foundStatus) {
                    // A grpc-status: 0 response header was present. This is a "trailers-only"
                    // response (a response without a body and no trailers).
                    //
                    // The spec seems to disallow a trailers-only response for status 0 - we are
                    // lenient and only verify that the body is empty.
                    //
                    // > [...] Trailers-Only is permitted for calls that produce an immediate error.
                    // See https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
                    const r = await iterable[Symbol.asyncIterator]().next();
                    if (r.done !== true) {
                      throw new ConnectError(
                        "protocol error: extra data for trailers-only",
                        Code.InvalidArgument
                      );
                    }
                    return;
                  }
                  let trailerReceived = false;
                  for await (const chunk of iterable) {
                    if (chunk.end) {
                      if (trailerReceived) {
                        throw new ConnectError(
                          "protocol error: received extra trailer",
                          Code.InvalidArgument
                        );
                      }
                      trailerReceived = true;
                      validateTrailer(chunk.value);
                      chunk.value.forEach((value, key) =>
                        res.trailer.set(key, value)
                      );
                      continue;
                    }
                    if (trailerReceived) {
                      throw new ConnectError(
                        "protocol error: received extra message after trailer",
                        Code.InvalidArgument
                      );
                    }
                    yield chunk.value;
                  }
                  if (!trailerReceived) {
                    throw new ConnectError(
                      "protocol error: missing trailer",
                      Code.InvalidArgument
                    );
                  }
                },
                transformCatchFinally<O>((e): void => {
                  if (e !== undefined) {
                    ac.abort(e);
                    throw e;
                  }
                }),
                { propagateDownStreamError: true }
              ),
            };
            return res;
          } catch (e) {
            ac.abort(e);
            throw e;
          }
        },
        opt.interceptors
      );
    },
  };
}
