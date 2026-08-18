export async function connectSse(
  token: string,
  safeHost: string,
  safePort: number,
  onMessage: (raw: string) => void,
  onDisconnect: () => void,
  version: string,
): Promise<AbortController | null> {
  // 1. Initial auth check
  const authRes = await fetch(`http://${safeHost}:${safePort}/auth`, {
    method: "QUERY",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Extension-Version": version,
    },
    body: JSON.stringify({
      type: "auth",
      token: token,
      extensionVersion: version,
    }),
  });

  if (!authRes.ok) {
    throw new Error(`HTTP auth failed with status ${authRes.status}`);
  }

  // 2. Connect to SSE stream
  const controller = new AbortController();
  const sseRes = await fetch(`http://${safeHost}:${safePort}/events`, {
    method: "QUERY",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: controller.signal,
  });

  if (!sseRes.ok || !sseRes.body) {
    return null;
  }

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        processBlocks(blocks, onMessage);
      }
    } catch {
      // Stream completed or cancelled
    } finally {
      onDisconnect();
    }
  })();

  return controller;
}

function processBlocks(blocks: string[], onMessage: (raw: string) => void): void {
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        const raw = line.slice(6).trim();
        if (raw) {
          onMessage(raw);
        }
      }
    }
  }
}
