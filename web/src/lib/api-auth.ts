/**
 * Reusable auth guard for API endpoints.
 * Checks Clerk session and returns userId, or returns a 401 Response.
 *
 * Usage:
 *   import { requireAuth } from '../../lib/api-auth';
 *
 *   export const GET: APIRoute = async ({ locals, url }) => {
 *     const { userId, error } = requireAuth(locals);
 *     if (error) return error;
 *     // ... handler logic
 *   };
 */

interface AuthResult {
  userId: string | null;
  error: Response | null;
}

export function requireAuth(locals: any): AuthResult {
  const auth = (locals as any)?.auth?.();
  const userId = auth?.userId;

  if (!userId) {
    return {
      userId: null,
      error: new Response(
        JSON.stringify({ error: 'Debes iniciar sesión para acceder a este recurso', code: 'auth_required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }

  return { userId, error: null };
}