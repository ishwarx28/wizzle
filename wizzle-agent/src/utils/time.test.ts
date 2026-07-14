import { formatExactMessageTimestamp } from "./time.ts";

function assertEqual(actual: string, expected: string) {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, received ${actual}.`);
  }
}

const sameDay = new Date(2026, 6, 15, 13, 5).getTime();
assertEqual(formatExactMessageTimestamp(sameDay, sameDay), "13:05");

const midnight = new Date(2026, 6, 15, 0, 7).getTime();
assertEqual(formatExactMessageTimestamp(midnight, sameDay), "00:07");

const earlierDate = new Date(2026, 0, 2, 23, 9).getTime();
assertEqual(formatExactMessageTimestamp(earlierDate, sameDay), "Jan 2, 23:09");

console.log("time formatting tests passed");
