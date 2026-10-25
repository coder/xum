/**
 * Cost the ConnectionLink adds per call and per stream event, against the inner link alone.
 * Run: make bench BENCH=connectionLink
 *
 * Every API call and every stream event (terminal output, chat deltas) goes through the link
 * once the provider uses it. Gate for the switch: the wrapper must add less than 1 µs per event.
 */
import { bench, do_not_optimize, summary } from "mitata";
import type { ClientContext, ClientLink, ClientOptions } from "@orpc/client";
import { createClient } from "@/common/orpc/client";
import { ConnectionLink } from "@/browser/contexts/connectionLink";

const OPTIONS: ClientOptions<ClientContext> = { context: {} };
const EVENTS = 1000;

/** A stream that yields EVENTS values with no I/O, so the bench measures only the wrappers. */
function syntheticStream(): AsyncIteratorObject<unknown, unknown, unknown> &
  AsyncIterable<unknown> {
  let i = 0;
  const stream = {
    next: () =>
      Promise.resolve(
        i < EVENTS
          ? { done: false as const, value: { n: i++ } }
          : { done: true as const, value: undefined }
      ),
    return: (value?: unknown) => Promise.resolve({ done: true as const, value }),
    throw: (error?: unknown) =>
      Promise.reject(error instanceof Error ? error : new Error(String(error))),
    [Symbol.asyncIterator]() {
      return stream;
    },
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  return stream;
}

const callLink: ClientLink<ClientContext> = { call: () => Promise.resolve("pong") };
const streamLink: ClientLink<ClientContext> = { call: () => Promise.resolve(syntheticStream()) };

function attached(inner: ClientLink<ClientContext>): ClientLink<ClientContext> {
  const link = new ConnectionLink();
  link.attach(inner);
  return link;
}

const wrappedCallLink = attached(callLink);
const wrappedStreamLink = attached(streamLink);

summary(() => {
  bench("one-shot call: inner link", async () => {
    do_not_optimize(await callLink.call(["general", "ping"], "x", OPTIONS));
  });
  bench("one-shot call: ConnectionLink", async () => {
    do_not_optimize(await wrappedCallLink.call(["general", "ping"], "x", OPTIONS));
  });
});

summary(() => {
  bench(`stream of ${EVENTS} events: inner link`, async () => {
    const stream = (await streamLink.call(
      ["terminal", "attach"],
      {},
      OPTIONS
    )) as AsyncIterable<unknown>;
    for await (const event of stream) do_not_optimize(event);
  });
  bench(`stream of ${EVENTS} events: ConnectionLink`, async () => {
    const stream = (await wrappedStreamLink.call(
      ["terminal", "attach"],
      {},
      OPTIONS
    )) as AsyncIterable<unknown>;
    for await (const event of stream) do_not_optimize(event);
  });
});

// Runs once per successful connect after the switch: a new client on the shared link.
bench("createClient(link) + first property access", () => {
  const client = createClient(wrappedCallLink);
  do_not_optimize(client.general.ping);
});
