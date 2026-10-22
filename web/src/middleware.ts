import { clerkMiddleware, createRouteMatcher } from '@clerk/astro/server';

// Legacy page redirects (permanent 301)
const REDIRECTS: Record<string, string> = {
  '/buscador': '/buscar',
  '/components': '/',
  '/advanced-components': '/',
  '/proximamente': '/',
};

// Routes that require authentication
const isProtectedRoute = createRouteMatcher([
  '/explorer(.*)',
  '/monitor(.*)',
  '/dashboard(.*)',
  '/cuenta(.*)',
]);

// RFC 8288 Link headers for agent discovery
const LINK_HEADERS = [
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/json"',
  '</.well-known/agent.json>; rel="agent-json"; type="application/json"',
  '</sitemap-index.xml>; rel="sitemap"; type="application/xml"',
  '</robots.txt>; rel="robots"',
];

export const onRequest = clerkMiddleware(async (auth, context, next) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname.endsWith('/') && url.pathname !== '/'
    ? url.pathname.slice(0, -1)
    : url.pathname;

  // Handle legacy page redirects before auth
  if (pathname in REDIRECTS) {
    const target = new URL(REDIRECTS[pathname], context.request.url).toString();
    return Response.redirect(target, 301);
  }

  // Skip Clerk auth for API v1 endpoints — they handle their own auth via API keys
  if (url.pathname.startsWith('/api/v1/')) {
    const response = await next();
    return response;
  }

  // Handle Clerk auth
  if (isProtectedRoute(context.request)) {
    const { userId } = auth();
    if (!userId) {
      return Response.redirect(new URL('/sign-in', context.request.url).toString(), 302);
    }

    // CIF is now optional — users can explore the dashboard without configuring a company.
    // The sidebar shows a soft CTA to configure company when no CIF is set.
    // No redirect needed here.
  }

  // Get the response from next handler
  const response = await next();

  // Clone response to add Link headers (RFC 8288)
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // Add Link headers for agent discovery
  const existingLink = newResponse.headers.get('Link');
  const linkValue = existingLink
    ? `${existingLink}, ${LINK_HEADERS.join(', ')}`
    : LINK_HEADERS.join(', ');
  newResponse.headers.set('Link', linkValue);

  // Add CORS headers for .well-known paths
  if (url.pathname.startsWith('/.well-known/')) {
    newResponse.headers.set('Access-Control-Allow-Origin', '*');
    newResponse.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    newResponse.headers.set('Cache-Control', 'public, max-age=3600');
  }

  return newResponse;
});
