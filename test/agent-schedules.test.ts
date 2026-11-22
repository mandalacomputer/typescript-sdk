/**
 * Agent schedules: background runs started on a timetable, made on a computer
 * and read, changed, paused, resumed and deleted by id.
 */

import { describe, expect, it } from 'vitest';
import { Client, MandalaError, NotFoundError, ValidationError } from '../src/index.js';
import { BASE, json, type Responder, recorder } from './harness.js';

const SCHEDULE = {
  id: 'sch_fedcba9876543210fedcba98',
  computer_id: 'vm-1',
  thread_id: null,
  name: 'Weekday build check',
  cron: '0 9 * * MON-FRI',
  timezone: 'America/New_York',
  prompt: 'Check the overnight build',
  model: 'claude-sonnet-5-5',
  max_steps: 60,
  max_cost_usd: 2,
  paused: false,
  paused_reason: null,
  next_fire_at: '2026-11-24T14:00:00.000Z',
  last_fire_at: '2026-11-23T14:00:00.000Z',
  last_run_id: 'run_89abcdef0123456789abcdef',
  created_at: '2026-11-20T16:12:00.000Z',
  updated_at: '2026-11-20T16:12:00.000Z',
  recent_fires: [
    {
      scheduled_for: '2026-11-23T14:00:00.000Z',
      fired_at: '2026-11-23T14:00:04.000Z',
      outcome: 'started',
      run_id: 'run_89abcdef0123456789abcdef',
      error: null,
    },
  ],
};

function sdk(respond: Responder) {
  const rec = recorder(respond);
  return { rec, client: new Client({ apiKey: 'com_test', baseUrl: BASE, fetch: rec.fetch }) };
}

describe('client.agentSchedules', () => {
  it('creates on a computer, sending the wire names', async () => {
    const { rec, client } = sdk(() => json(SCHEDULE, { status: 201 }));
    const made = await client.agentSchedules.create('vm-1', {
      cron: '0 9 * * MON-FRI',
      timezone: 'America/New_York',
      prompt: 'Check the overnight build',
      maxSteps: 60,
      maxCostUsd: 2,
      name: 'Weekday build check',
    });
    expect(rec.last()).toMatchObject({
      method: 'POST',
      path: '/computers/vm-1/agent/schedules',
      body: {
        cron: '0 9 * * MON-FRI',
        timezone: 'America/New_York',
        prompt: 'Check the overnight build',
        max_steps: 60,
        max_cost_usd: 2,
        name: 'Weekday build check',
      },
    });
    expect(rec.last().headers).not.toHaveProperty('X-Model-Key');
    expect(made).toMatchObject({
      id: SCHEDULE.id,
      computerId: 'vm-1',
      threadId: null,
      paused: false,
      pausedReason: null,
      nextFireAt: SCHEDULE.next_fire_at,
      lastRunId: SCHEDULE.last_run_id,
      recentFires: [{ outcome: 'started', runId: SCHEDULE.last_run_id, error: null }],
    });
  });

  it('refuses locally what a schedule cannot keep, before any request', async () => {
    const { rec, client } = sdk(() => json(SCHEDULE));
    const bad = [
      { prompt: 'x' },
      { cron: '0 9 * * *' },
      { cron: '0 9 * * *', prompt: 'x', modelKey: 'sk-ant-x' },
      { cron: '0 9 * * *', prompt: 'x', system: 'be terse' },
      { cron: '0 9 * * *', prompt: 'x', maxSteps: 1.5 },
      { cron: '0 9 * * *', prompt: 'x', colour: 'red' },
    ];
    for (const args of bad)
      await expect(client.agentSchedules.create('vm-1', args as never)).rejects.toBeInstanceOf(
        ValidationError,
      );
    expect(rec.calls).toEqual([]);
  });

  it('lists a page and says where the next starts', async () => {
    const { rec, client } = sdk(() =>
      json({ schedules: [{ ...SCHEDULE, recent_fires: [] }], has_more: true }),
    );
    const page = await client.agentSchedules.list({ computerId: 'vm-1', limit: 1 });
    expect(rec.last()).toMatchObject({
      method: 'GET',
      path: '/agent/schedules',
      query: { computer_id: 'vm-1', limit: '1' },
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe(SCHEDULE.id);
    expect(page.schedules[0]?.recentFires).toEqual([]);
  });

  it('reads, changes, pauses, resumes and deletes by id', async () => {
    const { rec, client } = sdk((call) =>
      call.method === 'DELETE' ? json({ ok: true }) : json(SCHEDULE),
    );
    await client.agentSchedules.get(SCHEDULE.id);
    expect(rec.last()).toMatchObject({ method: 'GET', path: `/agent/schedules/${SCHEDULE.id}` });
    await client.agentSchedules.update(SCHEDULE.id, { prompt: 'New job', threadId: null });
    expect(rec.last()).toMatchObject({
      method: 'PATCH',
      body: { prompt: 'New job', thread_id: null },
    });
    await client.agentSchedules.pause(SCHEDULE.id);
    expect(rec.last()).toMatchObject({ method: 'PATCH', body: { paused: true } });
    await client.agentSchedules.resume(SCHEDULE.id);
    expect(rec.last()).toMatchObject({ method: 'PATCH', body: { paused: false } });
    await client.agentSchedules.delete(SCHEDULE.id);
    expect(rec.last()).toMatchObject({ method: 'DELETE', path: `/agent/schedules/${SCHEDULE.id}` });
  });

  it('keeps a paused reason or a fire outcome it does not know', async () => {
    const { client } = sdk(() =>
      json({
        ...SCHEDULE,
        paused: true,
        paused_reason: 'something_new',
        recent_fires: [{ ...SCHEDULE.recent_fires[0], outcome: 'deferred' }],
      }),
    );
    const read = await client.agentSchedules.get(SCHEDULE.id);
    expect(read.pausedReason).toBe('something_new');
    expect(read.recentFires[0]?.outcome).toBe('deferred');
  });

  it('refuses an answer that does not say whether it is paused', async () => {
    const { client } = sdk(() => json({ ...SCHEDULE, paused: undefined }));
    await expect(client.agentSchedules.get(SCHEDULE.id)).rejects.toBeInstanceOf(MandalaError);
  });

  it('answers a schedule this key cannot see as NotFoundError', async () => {
    const { client } = sdk(() => json({ error: 'schedule not found' }, { status: 404 }));
    await expect(client.agentSchedules.get(SCHEDULE.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an empty id rather than reach the collection', async () => {
    const { rec, client } = sdk(() => json(SCHEDULE));
    await expect(client.agentSchedules.get('')).rejects.toBeInstanceOf(ValidationError);
    expect(rec.calls).toEqual([]);
  });
});
