import { createHash } from "node:crypto";
import { getAuth } from "@clerk/express";
import type { Request, Response } from "express";
import { pool } from "@workspace/db";
import { getClerkProxyHost } from "../middlewares/clerkProxyMiddleware";

export function getUserId(req: Request): string | null {
  return getAuth(req).userId ?? null;
}

export function requireUser(req: Request, res: Response): string | null {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED", message: "请先登录。" });
    return null;
  }
  return userId;
}

export function getAccountScope(userId: string): string {
  return createHash("sha256").update(`image-draft:${userId}`).digest("hex");
}

export function verifyAccountScope(req: Request, res: Response, userId: string): boolean {
  const expected = getAccountScope(userId);
  if (req.get("X-Ledger-Account-Scope") !== expected) {
    res.status(409).json({
      error: "ACCOUNT_CHANGED",
      message: "当前登录账号与本机草稿不匹配，请重新验证。",
    });
    return false;
  }
  return true;
}

export async function ensureAccount(userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO accounts (id, display_name)
     VALUES ($1, '本人')
     ON CONFLICT (id) DO NOTHING`,
    [userId],
  );
}

export function verifySameOrigin(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = (getClerkProxyHost(req) || "").toLowerCase();
    return !requestHost || originHost === requestHost;
  } catch {
    return false;
  }
}
