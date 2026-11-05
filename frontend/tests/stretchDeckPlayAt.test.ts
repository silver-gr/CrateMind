import { afterEach, beforeAll, expect, test } from "bun:test";
import { stretchParams } from "../src/lib/audio/stretchDeck";
import { installLocation, setup, teardown } from "./stretchDeckFakes";

beforeAll(installLocation);
afterEach(teardown);

// Fake ctx: currentTime 10, node latency 0.12 → lead 0.16.
async function loaded() {
  const h = setup();
  await h.load();
  h.log.length = 0;
  return h;
}

test("playAt starts a paused decoded deck at a future ctx time: anchor, muted pre-roll, events", async () => {
  const { deck, ctx, node, log } = await loaded();
  const fade = ctx.gains[1];
  fade.gain.calls.length = 0;
  expect(deck.playAt(12, 30, 1)).toBe(12);
  expect(node.last()).toMatchObject({ active: true, input: 30, outputTime: 12, rate: 1, semitones: 0, loopStart: 0, loopEnd: 0 });
  expect(fade.gain.calls).toEqual([["cancel", 10], ["set", 0, 10], ["set", 0, 12], ["ramp", 1, 12.01]]);
  expect(log).toEqual(["play", "playing"]);
  expect(deck.paused).toBe(false);
  expect(deck.startsAt).toBe(12);
  ctx.currentTime = 11;
  expect(deck.currentTime).toBe(30);
  expect(deck.startsAt).toBe(12);
  ctx.currentTime = 13;
  expect(deck.currentTime).toBeCloseTo(31);
  expect(deck.startsAt).toBeNull();
});

test("playAt after ended works and resets the ended flag", async () => {
  const { deck, ctx } = await loaded();
  await deck.play();
  ctx.currentTime = 1000;
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(deck.ended).toBe(true);
  expect(deck.playAt(1002, 5, 1)).toBe(1002);
  expect(deck.ended).toBe(false);
  ctx.currentTime = 1001;
  expect(deck.currentTime).toBe(5);
});

test("playAt refuses inside the lead, on a playing or undecoded deck, on a stopped context and for a bad rate", async () => {
  const { deck, ctx, node } = await loaded();
  const sent = node.scheduled.length;
  expect(deck.playAt(10.1, 30, 1)).toBeNull();
  expect(deck.playAt(12, 30, 0)).toBeNull();
  expect(deck.playAt(12, 30, Number.NaN)).toBeNull();
  expect(deck.playAt(12, Number.NaN, 1)).toBeNull();
  ctx.state = "suspended";
  expect(deck.playAt(12, 30, 1)).toBeNull();
  ctx.state = "running";
  expect(node.scheduled.length).toBe(sent);
  expect(deck.paused).toBe(true);
  await deck.play();
  expect(deck.playAt(12, 30, 1)).toBeNull();

  const fresh = setup();
  expect(fresh.deck.playAt(12, 30, 1)).toBeNull();
});

test("playAt sets the rate it was given, with semitones per key lock", async () => {
  const { deck, node } = await loaded();
  expect(deck.playAt(12, 30, 1.05)).toBe(12);
  expect(deck.playbackRate).toBe(1.05);
  expect(node.last()).toMatchObject({ rate: 1.05, semitones: 0 });
  deck.pause();
  deck.preservesPitch = false;
  expect(deck.playAt(14, 30, 1.05)).toBe(14);
  expect(node.last()).toMatchObject({ rate: 1.05, semitones: stretchParams(1.05, false).semitones });
});

test("pause before T0 is clean: held input, the fade is cancelled, a pause event", async () => {
  const { deck, ctx, node, log } = await loaded();
  deck.playAt(12, 30, 1);
  const fade = ctx.gains[1];
  fade.gain.calls.length = 0;
  ctx.currentTime = 11;
  log.length = 0;
  deck.pause();
  expect(node.last()).toMatchObject({ active: false, input: 30, outputTime: 11.015 });
  expect(fade.gain.calls[0]).toEqual(["cancel", 11]);
  expect(log).toEqual(["pause"]);
  expect(deck.startsAt).toBeNull();
  expect(deck.currentTime).toBe(30);
});

test("timeOf maps a track position to ctx time on the current anchor; null when stopped or a loop wraps first", async () => {
  const { deck, ctx } = await loaded();
  expect(deck.timeOf(40)).toBeNull();
  deck.playAt(12, 30, 1);
  expect(deck.timeOf(40)).toBe(22);
  ctx.currentTime = 13;
  expect(deck.timeOf(40)).toBe(22);
  expect(deck.setLoop(35, 37)).toBe(true);
  expect(deck.timeOf(40)).toBeNull();
  expect(deck.timeOf(36)).toBeCloseTo(18);
  deck.clearLoop();
  deck.pause();
  expect(deck.timeOf(40)).toBeNull();
});

test("timeOf scales with the rate and is null past the end of the track", async () => {
  const { deck } = await loaded();
  deck.playAt(12, 30, 2);
  expect(deck.timeOf(40)).toBe(17);
  expect(deck.timeOf(101)).toBeNull();
});
