/**
 * Sites that check where a request comes from: the extension's own downloads carry no
 * Referer, so a session rule gives requests to the video's host the page's Referer and Origin —
 * and, for a site whose links are made for another client (YouTube, that client's User-Agent.
 * The rule touches only the extension's own requests, never the person's browsing.
 */
const FIRST_ID = 1000;

export async function useReferer(
  urls: string[],
  referer: string,
  userAgent?: string,
): Promise<void> {
  let origin: string;
  try {
    origin = new URL(referer).origin;
  } catch {
    return;
  }
  // Addresses of the web only: a blob: of a page (Telegram Web) has no host to rule on.
  const hosts = [
    ...new Set(urls.filter((u) => /^https?:/.test(u)).map((u) => new URL(u).hostname)),
  ];
  if (!hosts.length) return;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  let next = Math.max(FIRST_ID - 1, ...rules.map((r) => r.id)) + 1;
  const removeRuleIds: number[] = [];
  const addRules: chrome.declarativeNetRequest.Rule[] = hosts.map((host) => {
    const old = rules.find((r) => r.condition.requestDomains?.[0] === host);
    if (old) removeRuleIds.push(old.id);
    return {
      id: old?.id ?? next++,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          {
            header: 'referer',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: referer,
          },
          {
            header: 'origin',
            operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
            value: origin,
          },
          ...(userAgent
            ? [
                {
                  header: 'user-agent',
                  operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
                  value: userAgent,
                },
              ]
            : []),
        ],
      },
      condition: {
        requestDomains: [host],
        // The extension's own requests, from wherever it makes them (the service worker, the
        // offscreen document, the popup — also opened as a tab or a window), never a page's. Their
        // origin's host: the id in Chromium, the install's own uuid in Firefox.
        initiatorDomains: [new URL(chrome.runtime.getURL('')).host],
        resourceTypes: [
          'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
          'media' as chrome.declarativeNetRequest.ResourceType,
          'other' as chrome.declarativeNetRequest.ResourceType,
        ],
      },
    };
  });
  if (addRules.length)
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}
