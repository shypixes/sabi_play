/**
 * MOCK Supabase client for integration tests. It records what our server code asks for and
 * returns canned responses. It does NOT implement RLS, constraints or auth: anything proven
 * with it is about OUR code (auth gating, validation, argument shaping, error mapping), never
 * about database security. Database security is covered by tests/db against real PostgreSQL.
 */

type Response = { data: unknown; error: { code?: string; message?: string } | null };

export type FakeState = {
  user: { id: string } | null;
  tables: Record<string, Response>;
  rpc: Record<string, Response>;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  queries: { table: string; ops: [string, unknown[]][] }[];
};

export function createFakeState(): FakeState {
  return { user: null, tables: {}, rpc: {}, rpcCalls: [], queries: [] };
}

export function createFakeClient(state: FakeState) {
  return {
    auth: {
      getUser: async () =>
        state.user
          ? { data: { user: state.user }, error: null }
          : { data: { user: null }, error: { message: "Auth session missing!" } },
    },
    rpc: async (fn: string, args: Record<string, unknown>): Promise<Response> => {
      state.rpcCalls.push({ fn, args });
      return state.rpc[fn] ?? { data: null, error: { code: "PGRST202", message: `no fake for ${fn}` } };
    },
    from(table: string) {
      const record = { table, ops: [] as [string, unknown[]][] };
      state.queries.push(record);
      const builder = {
        select: (...a: unknown[]) => (record.ops.push(["select", a]), builder),
        eq: (...a: unknown[]) => (record.ops.push(["eq", a]), builder),
        order: (...a: unknown[]) => (record.ops.push(["order", a]), builder),
        limit: (...a: unknown[]) => (record.ops.push(["limit", a]), builder),
        maybeSingle: () => (record.ops.push(["maybeSingle", []]), builder),
        then<T>(resolve: (r: Response) => T, reject?: (e: unknown) => T) {
          return Promise.resolve(state.tables[table] ?? { data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}
