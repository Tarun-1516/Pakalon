/**
 * /upstream-proxy — configure an HTTP/SOCKS proxy for all outbound
 * calls. Useful for self-hosted users that route through a corporate
 * proxy.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import logger from "@/utils/logger.js";

const SETTINGS = path.join(os.homedir(), ".config", "pakalon", "settings.json");

export interface ProxyConfig {
  http?: string;
  https?: string;
  noProxy?: string[];
}

export function setProxy(proxy: ProxyConfig): void {
  const dir = path.dirname(SETTINGS);
  fs.mkdirSync(dir, { recursive: true });
  let cur: any = {};
  try {
    cur = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
  } catch {
    // fresh
  }
  cur.proxy = proxy;
  fs.writeFileSync(SETTINGS, JSON.stringify(cur, null, 2), "utf-8");
  if (proxy.http) process.env.HTTP_PROXY = proxy.http;
  if (proxy.https) process.env.HTTPS_PROXY = proxy.https;
  if (proxy.noProxy?.length) process.env.NO_PROXY = proxy.noProxy.join(",");
  logger.info({ proxy }, "Proxy configured");
}

export function clearProxy(): void {
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
  try {
    const cur = JSON.parse(fs.readFileSync(SETTINGS, "utf-8"));
    delete cur.proxy;
    fs.writeFileSync(SETTINGS, JSON.stringify(cur, null, 2), "utf-8");
  } catch {
    // ignore
  }
}
