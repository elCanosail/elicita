import type { IncomingMessage } from 'node:http';

export const MAX_MCP_BODY_BYTES = 64 * 1024;
export class BodyError extends Error {
  constructor(public readonly status: 400 | 413, message: string) { super(message); }
}

// Parse once and pass parsedBody to the SDK. Count actual bytes, including chunked requests.
export function readMcpBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => fail(400, 'body_timeout'), 10_000);
    timer.unref();
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      chunks.length = 0;
    };
    const fail = (status: 400 | 413, message: string) => {
      if (settled) return;
      finish();
      req.pause();
      reject(new BodyError(status, message));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) return fail(413, 'body_too_large');
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body === null) return fail(400, 'invalid_json_body');
        finish();
        resolve(body);
      } catch { fail(400, 'invalid_json_body'); }
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', () => fail(400, 'body_aborted'));
    req.once('error', () => fail(400, 'body_aborted'));
    const length = req.headers['content-length'];
    if (length !== undefined && Number(length) > MAX_MCP_BODY_BYTES) fail(413, 'body_too_large');
    else if (req.aborted) fail(400, 'body_aborted');
  });
}
