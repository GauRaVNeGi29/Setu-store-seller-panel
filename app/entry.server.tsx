import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import db from "./db.server";
import { startMailClock } from "./lib/mail/daily.server";
import { kick } from "./lib/mail/queue.server";

export const streamTimeout = 5000;

// Mail: send anything left waiting from before a restart, and start the daily checks.
kick(db);
startMailClock(db);

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  addDocumentResponseHeaders(request, responseHeaders);
  if (new URL(request.url).pathname.startsWith("/portal")) {
    // Vendor portal: never framed, no referrer leaks to other sites, never cached by shared caches.
    // "same-origin" (not "no-referrer"): with "no-referrer" browsers send `Origin: null` on form
    // posts, and React Router's CSRF check then rejects every form sent before JavaScript loads.
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");
    responseHeaders.set("Referrer-Policy", "same-origin");
    responseHeaders.set("Cache-Control", "private, no-store");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
