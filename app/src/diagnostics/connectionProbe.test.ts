import { describe, expect, it } from 'vitest';
import { probeConnection } from './connectionProbe';

/** expo-sqlite 57's Android behaviour: a shared open's handle, once released, closes the app's connection too. */
function world(shared: boolean) {
  let dead = false;
  return {
    read: async () => {
      if (dead) throw new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.");
    },
    openJob: async () => ({
      closeAsync: async () => {},
      nativeDatabase: {
        release: () => {
          if (shared) dead = true;
        },
      },
    }),
  };
}

describe('probeConnection', () => {
  it("fails the round after which the app's connection no longer reads", async () => {
    const r = await probeConnection(world(true), 3);
    expect(r.map((x) => [x.name, x.ok])).toEqual([
      ['before', true],
      ['round 1', false],
    ]);
    expect(r[1].detail).toContain('NativeDatabase.prepareAsync');
  });

  it('passes every round when the job has a connection of its own', async () => {
    const r = await probeConnection(world(false), 3);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r).toHaveLength(4);
  });

  it("stops at once when the app's connection doesn't read to begin with", async () => {
    const r = await probeConnection({ ...world(false), read: async () => Promise.reject(new Error('locked')) }, 3);
    expect(r).toEqual([{ name: 'before', ok: false, detail: 'locked' }]);
  });

  it("kills the app's connection with a shared open, then reads again after the store's reconnect", async () => {
    let dead = false;
    let reconnects = 0;
    const handle = (kills: boolean) => async () => ({
      closeAsync: async () => {},
      nativeDatabase: { release: () => void (kills && (dead = true)) },
    });
    const r = await probeConnection(
      {
        read: async () => {
          if (dead) throw new Error("Call to function 'NativeDatabase.prepareAsync' has been rejected.");
        },
        openJob: handle(false),
        recover: {
          openShared: handle(true),
          reconnect: async () => {
            reconnects++;
            dead = false;
            return true;
          },
        },
      },
      1,
    );
    expect(r.map((x) => [x.name, x.ok, x.detail])).toEqual([
      ['before', true, "the app's connection reads"],
      ['round 1', true, "the app's connection reads"],
      ['killed', true, "Call to function 'NativeDatabase.prepareAsync' has been rejected."],
      ['reconnected', true, 'a new connection'],
      ['after reconnect', true, "the app's connection reads"],
    ]);
    expect(reconnects).toBe(1);
  });

  it('fails, and tries no reconnect, when the shared open leaves the connection reading', async () => {
    let reconnects = 0;
    const handle = async () => ({ closeAsync: async () => {}, nativeDatabase: { release: () => {} } });
    const r = await probeConnection(
      { read: async () => {}, openJob: handle, recover: { openShared: handle, reconnect: async () => (reconnects++, true) } },
      1,
    );
    expect(r.at(-1)).toEqual({ name: 'killed', ok: false, detail: 'the shared open left it reading, so the way back was not tried' });
    expect(reconnects).toBe(0);
  });

  it("says so when the job's open itself fails", async () => {
    const r = await probeConnection({ ...world(false), openJob: async () => Promise.reject(new Error('no file')) }, 3);
    expect(r[1]).toEqual({ name: 'round 1', ok: false, detail: "the job's open, close or release failed: no file" });
  });
});
