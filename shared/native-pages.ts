export type NativeInput =
  | { kind: 'search_page'; query: string; cursor: number; searchId: string; count: number }
  | { kind: 'related'; videoId: string; excludedIds: string[]; count: number };
export type NativePage = {
  request: NativeInput;
  responsePath: string;
  observedAt: string;
  bodySha256: string;
  ids: string[];
  cursor: number | null;
  cursorRaw: string | number | null;
  hasMore: boolean | null;
  hasMoreRaw: boolean | number | null;
  searchId: string | null;
  unparsedRows: number;
  contractBasis: 'pinned_public_client_not_live_verified';
};
