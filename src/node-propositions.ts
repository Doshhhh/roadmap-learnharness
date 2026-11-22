// The learner's own Knowledge Graph propositions for one roadmap node (issue #39).
// A node is mapped through its linked native sessions (childSessions), the same link follow-through reads:
// a proposition belongs to the node when one of its provenance points comes from one of those chats.
// Pure: no I/O. Nothing here reads or writes another plugin's data.

/** The fields of a stored graph proposition that the node panel shows. */
export interface NodeProposition {
  readonly id: string;
  readonly name: string;
  readonly statement: string;
}

/** The structural subset of a stored graph proposition this module reads. */
export interface PropositionSource {
  readonly id: string;
  readonly name: string;
  readonly statement: string;
  readonly provenance: readonly { readonly chatId: string }[];
}

/** Propositions whose provenance includes one of the given chats (a node's childSessions), in the order given. */
export function propositionsForChats(
  chatIds: readonly string[],
  propositions: readonly PropositionSource[],
): NodeProposition[] {
  const chats = new Set(chatIds);
  if (chats.size === 0) return [];
  return propositions
    .filter((proposition) => Array.isArray(proposition.provenance) && proposition.provenance.some((point) => chats.has(point.chatId)))
    .map(({ id, name, statement }) => ({ id, name, statement }));
}
