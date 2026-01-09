import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifySupabaseToken } from '../lib/supabase.js';

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      email?: string;
      [key: string]: any;
    };
  }
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  try {
    // Get token from Authorization header
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header',
      });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token with Supabase
    const user = await verifySupabaseToken(token);

    // Attach user to request
    request.user = {
      id: user.id,
      email: user.email,
      ...user.user_metadata,
    };
  } catch (error: any) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: error.message || 'Invalid token',
    });
  }
}

// Optional auth - doesn't block if no token provided
export async function optionalAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const user = await verifySupabaseToken(token);

      request.user = {
        id: user.id,
        email: user.email,
        ...user.user_metadata,
      };
    }
  } catch (error) {
    // Silently fail for optional auth
    console.warn('Optional auth failed:', error);
  }
}
