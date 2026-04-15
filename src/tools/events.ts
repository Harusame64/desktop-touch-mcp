import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, buildDesc } from "./_types.js";
import type { ToolResult } from "./_types.js";
import { failWith } from "./_errors.js";
import { coercedBoolean } from "./_coerce.js";
import { subscribe, poll, unsubscribe, getActiveSubscriptions } from "../engine/event-bus.js";

const EVENT_TYPES = ["window_appeared", "window_disappeared", "foreground_changed"] as const;

export const eventsSubscribeSchema = {
  types: z.array(z.enum(EVENT_TYPES)).min(1).default([...EVENT_TYPES]).describe("Event types to listen for."),
};

export const eventsPollSchema = {
  subscriptionId: z.string().describe("ID returned from events_subscribe."),
  sinceMs: z.coerce.number().optional().describe("Only return events newer than this epoch-ms timestamp."),
  drain: coercedBoolean().default(true).describe("Drain buffer after read (default true). Set false to peek without consuming."),
};

export const eventsUnsubscribeSchema = {
  subscriptionId: z.string().describe("ID returned from events_subscribe."),
};

export const eventsListSchema = {};

export const eventsSubscribeHandler = async ({ types }: { types: Array<typeof EVENT_TYPES[number]> }): Promise<ToolResult> => {
  try {
    const id = subscribe(types);
    return ok({ subscriptionId: id, types });
  } catch (err) {
    return failWith(err, "events_subscribe");
  }
};

export const eventsPollHandler = async ({ subscriptionId, sinceMs, drain }: { subscriptionId: string; sinceMs?: number; drain: boolean }): Promise<ToolResult> => {
  try {
    const events = poll(subscriptionId, sinceMs, drain);
    return ok({ count: events.length, events });
  } catch (err) {
    return failWith(err, "events_poll");
  }
};

export const eventsUnsubscribeHandler = async ({ subscriptionId }: { subscriptionId: string }): Promise<ToolResult> => {
  try {
    const removed = unsubscribe(subscriptionId);
    return ok({ removed });
  } catch (err) {
    return failWith(err, "events_unsubscribe");
  }
};

export const eventsListHandler = async (): Promise<ToolResult> => {
  try {
    return ok({ active: getActiveSubscriptions() });
  } catch (err) {
    return failWith(err, "events_list");
  }
};

export function registerEventTools(server: McpServer): void {
  server.tool(
    "events_subscribe",
    buildDesc({
      purpose: "Subscribe to window-state change events (appear/disappear/focus) for continuous monitoring without repeated polling.",
      details: "Returns subscriptionId. Events are buffered internally at 500ms intervals via EnumWindows; buffer holds up to 50 events (oldest dropped on overflow). Call events_poll(subscriptionId, sinceMs: lastEventTs) to drain incrementally; call events_unsubscribe when monitoring is complete. Each buffered event: {type, hwnd, title, timestamp}.",
      prefer: "Use instead of wait_until(window_appears) when you need to monitor multiple events simultaneously or over an extended period. Use wait_until for one-shot, single-condition waiting.",
      caveats: "Events that occurred before subscribe() was called will not appear — buffer starts empty. Poll frequently (every few seconds) during high-frequency window activity to avoid the 50-event overflow.",
      examples: [
        "id = events_subscribe() → poll: events_poll({subscriptionId:id}) → on next poll: events_poll({subscriptionId:id, sinceMs: lastEventTs}) → events_unsubscribe({subscriptionId:id})",
      ],
    }),
    eventsSubscribeSchema,
    eventsSubscribeHandler
  );
  server.tool(
    "events_poll",
    "Drain buffered events for a subscription. Pass sinceMs to filter to events newer than that timestamp (incremental polling).",
    eventsPollSchema,
    eventsPollHandler
  );
  server.tool(
    "events_unsubscribe",
    "Stop a subscription and free its event buffer.",
    eventsUnsubscribeSchema,
    eventsUnsubscribeHandler
  );
  server.tool(
    "events_list",
    "Return all active subscription IDs.",
    eventsListSchema,
    eventsListHandler
  );
}
