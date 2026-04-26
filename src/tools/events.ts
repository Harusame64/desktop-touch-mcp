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

// Phase 4: events_* tools privatized — entry-point removed, handlers retained
// as internal exports for tests / future facade. wait_until covers the common
// one-shot wait use case; the multi-event monitoring use case can be revived
// via a facade in a later phase if dogfood shows it's needed.
// (memory: feedback_disable_via_entry_block.md)
export function registerEventTools(_server: McpServer): void {
  // intentionally empty — handlers above remain exported.
}
