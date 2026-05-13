import { ref, computed, watch, nextTick, watchEffect } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { directMessageChannelId, peerToKey, keyToPeer } from "./directMessage.js";
import { searchOpenLibraryBooks, fetchOpenLibraryEditionByIsbn } from "./booksApi.js";

/** Shared directory for book club listings (Part A "where" for discovery). */
export const BOOK_CLUB_DIRECTORY = "bookclub-discovery";

/** Placeholder channel when no chat route is active so discover hooks stay valid. */
const IDLE_MESSAGE_CHANNEL = "00000000-0000-4000-8000-000000000000";

const bookClubCreateSchema = {
  properties: {
    value: {
      required: ["activity", "type", "channel", "published"],
      properties: {
        activity: { type: "string" },
        type: { const: "BookClub" },
        name: { type: "string" },
        channel: { type: "string" },
        ownerActor: { type: "string" },
        nextMeetingAt: { type: "string" },
        nextMeetingLocation: { type: "string" },
        allowedGenres: { type: "string" },
        nextBook: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};


/** Notes, book polls, votes, and close events share the club / DM channel. */
const messageChannelObjectSchema = {
  properties: {
    value: {
      required: ["type", "published"],
      properties: {
        type: { type: "string" },
        published: { type: "number" },
        content: { type: "string" },
        contextBook: { type: "string" },
        isBlurred: { type: "boolean" },
        spoilerWarning: { type: "string" },
        spoilerPage: { type: "number" },
        spoilerProgress: { type: "number" },
        pollId: { type: "string" },
        endsAt: { type: "number" },
        options: { type: "array" },
        optionId: { type: "string" },
        winnerOptionId: { type: "string" },
        winnerTitle: { type: "string" },
      },
    },
  },
};

const currentlyReadingSchema = {
  properties: {
    value: {
      required: ["type", "title", "published"],
      properties: {
        type: { const: "CurrentlyReading" },
        title: { type: "string" },
        isbn: { type: "string" },
        currentPage: { type: "number" },
        totalPages: { type: "number" },
        status: { type: "string" },
        statusUpdatedAt: { type: "number" },
        published: { type: "number" },
      },
    },
  },
};

const dmThreadIndexSchema = {
  properties: {
    value: {
      required: ["type", "peerActor", "updated"],
      properties: {
        type: { const: "DMThreadIndex" },
        peerActor: { type: "string" },
        updated: { type: "number" },
        lastPreview: { type: "string" },
      },
    },
  },
};

const clubMembershipSchema = {
  properties: {
    value: {
      required: ["type", "activity", "channel", "published"],
      properties: {
        type: { const: "ClubMembership" },
        activity: { type: "string" },
        channel: { type: "string" },
        published: { type: "number" },
      },
    },
  },
};

export function useShelfTalk() {
  const graffiti = useGraffiti();
  const session = useGraffitiSession();
  const route = useRoute();
  const router = useRouter();

  /** Club message channel while on live chat or the dedicated poll page (not settings). */
  const activeClubChannel = computed(() => {
    if (
      (route.name === "chat" || route.name === "chat-poll") &&
      route.params.chatId
    ) {
      return String(route.params.chatId);
    }
    return null;
  });

  /** Club id from URL on chat, poll, or club-settings routes. */
  const clubChannelFromRoute = computed(() => {
    if (
      (route.name === "chat" || route.name === "chat-poll" || route.name === "chat-settings") &&
      route.params.chatId
    ) {
      return String(route.params.chatId);
    }
    return null;
  });

  /** Kept as alias for club-only logic (sidebar active state, club metadata). */
  const activeChatChannel = activeClubChannel;

  const dmPeerActor = computed(() => {
    if (route.name !== "dm" || route.params.peerKey == null) return null;
    try {
      const peer = keyToPeer(String(route.params.peerKey));
      return peer.trim() ? peer : null;
    } catch {
      return null;
    }
  });

  const readerProfilePeerActor = computed(() => {
    if (route.name !== "reader" || route.params.peerKey == null) return null;
    try {
      const peer = keyToPeer(String(route.params.peerKey));
      return peer.trim() ? peer : null;
    } catch {
      return null;
    }
  });

  const readerProfileInvalid = computed(
    () =>
      route.name === "reader" && Boolean(route.params.peerKey) && readerProfilePeerActor.value == null,
  );

  const readerProfileDiscoverChannel = computed(() => {
    const peer = readerProfilePeerActor.value;
    return peer ? `${peer}/profile` : IDLE_MESSAGE_CHANNEL;
  });

  const { objects: rawReaderProfileObjects, isFirstPoll: readerProfilePollLoading } =
    useGraffitiDiscover(
      () => [readerProfileDiscoverChannel.value],
      currentlyReadingSchema,
      undefined,
      true,
    );

  const readerCurrentlyReading = computed(() => {
    const peer = readerProfilePeerActor.value;
    if (!peer) return [];
    return rawReaderProfileObjects.value
      .filter(
        (o) =>
          o.actor === peer &&
          o.value?.type === "CurrentlyReading" &&
          typeof o.value?.title === "string",
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
  });

  function splitBooksByStatus(entries) {
    const grouped = {
      reading: [],
      finished: [],
      dnf: [],
    };
    for (const entry of entries) {
      grouped[normalizeBookStatus(entry.value?.status)].push(entry);
    }
    return grouped;
  }

  const readerBooksByStatus = computed(() => splitBooksByStatus(readerCurrentlyReading.value));

  const dmPeerInvalid = computed(
    () => route.name === "dm" && Boolean(route.params.peerKey) && dmPeerActor.value == null,
  );

  const dmSelfConversation = computed(
    () =>
      route.name === "dm" &&
      dmPeerActor.value != null &&
      session.value?.actor != null &&
      dmPeerActor.value === session.value.actor,
  );

  const selectedMessageChannel = computed(() => {
    if (activeClubChannel.value) return activeClubChannel.value;
    if (
      route.name === "dm" &&
      dmPeerActor.value &&
      session.value?.actor &&
      dmPeerActor.value !== session.value.actor
    ) {
      return directMessageChannelId(session.value.actor, dmPeerActor.value);
    }
    return IDLE_MESSAGE_CHANNEL;
  });

  const newClubName = ref("");
  const clubSearchQuery = ref("");
  /** Search filter for the Book clubs page (only clubs you belong to). */
  const myClubsSearchQuery = ref("");
  const isCreatingClub = ref(false);
  const createClubError = ref("");
  const clubSettingsName = ref("");
  const clubSettingsNextMeetingAt = ref("");
  const clubSettingsNextMeetingLocation = ref("");
  const clubSettingsAllowedGenres = ref("");
  const clubSettingsNextBook = ref("");
  const showClubSettingsEditor = ref(false);
  const clubSettingsError = ref("");
  const showBookPollComposer = ref(false);
  const pollComposerError = ref("");
  const isPostingBookPoll = ref(false);
  const pollDraftRows = ref([
    { title: "", isbn: "", synopsis: "", totalPages: "" },
    { title: "", isbn: "", synopsis: "", totalPages: "" },
  ]);
  const pollOlQuery = ref("");
  const pollOlHits = ref([]);
  const pollOlSearching = ref(false);
  const pollOlError = ref("");
  /** @type {import('vue').Ref<AbortController | null>} */
  const pollOlAbort = ref(null);
  const pollOlTargetRow = ref(0);
  const pollVoteSelection = ref("");
  const isSubmittingPollVote = ref(false);
  const pollVoteError = ref("");
  const isFinalizingPoll = ref(false);
  const pollFinalizeError = ref("");
  const tieBreakOptionId = ref("");
  const pollAutoCloseLastId = ref("");
  const pollAutoClosingInFlight = ref(false);
  const isSavingClubSettings = ref(false);
  const isDeletingClub = ref(false);
  const isUpdatingMembership = ref(new Set());
  const channelInfoCopyFeedback = ref("");

  const myMessage = ref("");
  const contextBook = ref("");
  const markAsSpoiler = ref(false);
  const spoilerWarning = ref("");
  const spoilerPage = ref("");
  const spoilerProgressPercent = ref("");
  const isSending = ref(false);
  const sendError = ref("");

  const isDeleting = ref(new Set());
  const deleteError = ref("");
  const messageViewportRef = ref(null);

  const revealedMessageUrls = ref(new Set());

  watch(markAsSpoiler, (on) => {
    if (!on) contextBook.value = "";
  });

  watch(
    () => [
      route.name,
      route.params.chatId,
      route.params.peerKey,
      readerProfileDiscoverChannel.value,
    ],
    () => {
      revealedMessageUrls.value = new Set();
    },
  );

  const profileChannel = computed(() => {
    const actor = session.value?.actor;
    return actor ? `${actor}/profile` : IDLE_MESSAGE_CHANNEL;
  });

  const newBookTitle = ref("");
  const newBookIsbn = ref("");
  const newBookCurrentPage = ref("");
  const newBookTotalPages = ref("");
  const openLibrarySearchInput = ref("");
  const openLibraryHits = ref([]);
  const openLibrarySearching = ref(false);
  const openLibrarySearchError = ref("");
  /** @type {import('vue').Ref<AbortController | null>} */
  const openLibrarySearchAbort = ref(null);
  const showAddBookForm = ref(false);
  const isAddingBook = ref(false);
  const profileError = ref("");
  const isRemovingBook = ref(new Set());
  const isUpdatingBook = ref(new Set());
  const bookPageDrafts = ref({});

  const { objects: rawProfileObjects, isFirstPoll: profilePollLoading } =
    useGraffitiDiscover(
      () => [profileChannel.value],
      currentlyReadingSchema,
      undefined,
      true,
    );

  const { objects: rawDmIndexObjects } = useGraffitiDiscover(
    () => [profileChannel.value],
    dmThreadIndexSchema,
    undefined,
    true,
  );

  const { objects: rawMembershipObjects } = useGraffitiDiscover(
    () => [profileChannel.value],
    clubMembershipSchema,
    undefined,
    true,
  );

  const myCurrentlyReading = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return [];
    return rawProfileObjects.value
      .filter(
        (o) =>
          o.actor === actor &&
          o.value?.type === "CurrentlyReading" &&
          typeof o.value?.title === "string",
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
  });

  const myBooksByStatus = computed(() => splitBooksByStatus(myCurrentlyReading.value));

  const { objects: clubObjects, isFirstPoll: clubsLoading } = useGraffitiDiscover(
    [BOOK_CLUB_DIRECTORY],
    bookClubCreateSchema,
    undefined,
    true,
  );

  const sortedClubs = computed(() => {
    const byChannel = new Map();
    const events = clubObjects.value
      .filter((o) => o.value?.type === "BookClub" && typeof o.value?.channel === "string")
      .toSorted((a, b) => (a.value.published ?? 0) - (b.value.published ?? 0));
    for (const event of events) {
      const channel = event.value.channel;
      const activity = event.value.activity;
      if (activity === "Delete") {
        byChannel.delete(channel);
        continue;
      }
      if (activity !== "Create" && activity !== "Update") continue;
      const previous = byChannel.get(channel);
      const ownerActor =
        typeof event.value.ownerActor === "string" && event.value.ownerActor
          ? event.value.ownerActor
          : previous?.value?.ownerActor ?? previous?.actor ?? event.actor;
      const nextName =
        typeof event.value.name === "string" && event.value.name.trim()
          ? event.value.name.trim()
          : previous?.value?.name ?? "Untitled book club";
      const nextMeetingAt =
        typeof event.value.nextMeetingAt === "string"
          ? event.value.nextMeetingAt
          : previous?.value?.nextMeetingAt ?? "";
      const nextMeetingLocation =
        typeof event.value.nextMeetingLocation === "string"
          ? event.value.nextMeetingLocation
          : previous?.value?.nextMeetingLocation ?? "";
      const allowedGenres =
        typeof event.value.allowedGenres === "string"
          ? event.value.allowedGenres
          : previous?.value?.allowedGenres ?? "";
      const nextBook =
        typeof event.value.nextBook === "string"
          ? event.value.nextBook
          : previous?.value?.nextBook ?? "";
      byChannel.set(channel, {
        ...event,
        value: {
          ...event.value,
          name: nextName,
          ownerActor,
          nextMeetingAt,
          nextMeetingLocation,
          allowedGenres,
          nextBook,
          activity,
          channel,
        },
      });
    }
    return [...byChannel.values()].toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
  });

  const myClubMembershipByChannel = computed(() => {
    const actor = session.value?.actor;
    const latest = new Map();
    if (!actor) return latest;
    const events = rawMembershipObjects.value
      .filter((o) => o.actor === actor && o.value?.type === "ClubMembership")
      .toSorted((a, b) => (a.value.published ?? 0) - (b.value.published ?? 0));
    for (const e of events) {
      const channel = String(e.value?.channel ?? "");
      if (!channel) continue;
      latest.set(channel, e.value?.activity === "Join");
    }
    return latest;
  });

  function isMemberOfClub(channel) {
    const channelId = String(channel ?? "");
    const actor = session.value?.actor;
    if (!channelId || !actor) return false;
    const club = sortedClubs.value.find((c) => c.value?.channel === channelId);
    if (club && club.value?.ownerActor === actor) {
      return true;
    }
    if (myClubMembershipByChannel.value.get(channelId) === true) return true;
    /** Join mirror can land before profile discover catches up; still allow voting. */
    return hasClubChannelJoinMirror(actor, channelId);
  }

  const filteredClubs = computed(() => {
    const query = clubSearchQuery.value.trim().toLowerCase();
    if (!query) return sortedClubs.value;
    return sortedClubs.value.filter((club) =>
      (club.value?.name ?? "").toLowerCase().includes(query),
    );
  });

  const myMemberClubs = computed(() => {
    if (!session.value?.actor) return [];
    return sortedClubs.value.filter((club) => {
      const ch = club.value?.channel;
      return typeof ch === "string" && ch && isMemberOfClub(ch);
    });
  });

  const myFilteredMemberClubs = computed(() => {
    const q = myClubsSearchQuery.value.trim().toLowerCase();
    const list = myMemberClubs.value;
    if (!q) return list;
    return list.filter((c) => (c.value?.name ?? "").toLowerCase().includes(q));
  });

  const joinableDirectoryClubs = computed(() =>
    filteredClubs.value.filter((club) => {
      const ch = club.value?.channel;
      return typeof ch === "string" && ch && !isMemberOfClub(ch);
    }),
  );

  function isClubOwner(club) {
    const actor = session.value?.actor;
    const owner = club?.value?.ownerActor ?? club?.actor;
    return Boolean(actor && owner && actor === owner);
  }

  /** False while club directory is still loading so we do not hide the thread by mistake. */
  const activeClubRequiresJoin = computed(
    () =>
      clubChannelFromRoute.value != null &&
      !clubsLoading.value &&
      !isMemberOfClub(clubChannelFromRoute.value),
  );

  const clubForActiveChat = computed(() => {
    const ch = clubChannelFromRoute.value;
    if (!ch) return null;
    return sortedClubs.value.find((c) => c.value.channel === ch) ?? null;
  });

  const threadHeadTitle = computed(() => {
    if (!clubChannelFromRoute.value) return "";
    return clubForActiveChat.value?.value?.name ?? "Book club chat";
  });

  const activeClubOwnerActor = computed(() => {
    const club = clubForActiveChat.value;
    if (!club) return null;
    return club.value?.ownerActor ?? club.actor ?? null;
  });

  const userCanManageActiveClub = computed(
    () =>
      Boolean(
        session.value?.actor &&
          activeClubOwnerActor.value &&
          session.value.actor === activeClubOwnerActor.value,
      ),
  );

  function normalizeClubName(name) {
    return String(name ?? "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  }

  function isClubNameTaken(name, excludeChannel = null) {
    const key = normalizeClubName(name);
    if (!key) return false;
    return sortedClubs.value.some(
      (club) => normalizeClubName(club.value?.name) === key && club.value?.channel !== excludeChannel,
    );
  }

  const dmChannelPreview = computed(() => {
    if (route.name !== "dm" || !dmPeerActor.value || !session.value?.actor) return "";
    if (dmPeerActor.value === session.value.actor) return "";
    return directMessageChannelId(session.value.actor, dmPeerActor.value);
  });

  const dmInboxRows = computed(() => {
    const actor = session.value?.actor;
    if (!actor) return [];
    const best = new Map();
    for (const o of rawDmIndexObjects.value) {
      if (o.actor !== actor || o.value?.type !== "DMThreadIndex") continue;
      const peer = o.value.peerActor;
      if (typeof peer !== "string" || !peer) continue;
      const updated = o.value.updated ?? 0;
      const cur = best.get(peer);
      if (!cur || updated >= cur.updated) {
        best.set(peer, {
          peerActor: peer,
          updated,
          lastPreview: typeof o.value.lastPreview === "string" ? o.value.lastPreview : "",
        });
      }
    }
    return [...best.values()].toSorted((a, b) => b.updated - a.updated);
  });

  const newDmPeerInput = ref("");

  function openNewDm() {
    const raw = newDmPeerInput.value.trim();
    if (!raw) return;
    router.push({ name: "dm", params: { peerKey: peerToKey(raw) } });
    newDmPeerInput.value = "";
  }

  async function recordDmThread(peerActor, previewSnippet) {
    if (!session.value?.actor || !peerActor || peerActor === session.value.actor) return;
    try {
      await graffiti.post(
        {
          value: {
            type: "DMThreadIndex",
            peerActor,
            updated: Date.now(),
            lastPreview: String(previewSnippet ?? "").slice(0, 200),
          },
          channels: [profileChannel.value],
        },
        session.value,
      );
    } catch {
      /* inbox index is best-effort */
    }
  }

  watch(
    () => [route.name, dmPeerActor.value, session.value?.actor],
    ([name, peer, self]) => {
      if (name === "dm" && peer && self && peer !== self) {
        void recordDmThread(peer, "");
      }
    },
  );

  const { objects: rawChannelObjects, isFirstPoll: messagesLoading } = useGraffitiDiscover(
    () => [selectedMessageChannel.value],
    messageChannelObjectSchema,
    undefined,
    true,
  );

  /** Club channel while on settings only (chat uses `rawChannelObjects` above). */
  const settingsClubDiscoverChannel = computed(() => {
    if (route.name === "chat-settings" && route.params.chatId) {
      return String(route.params.chatId);
    }
    return IDLE_MESSAGE_CHANNEL;
  });

  const { objects: rawSettingsClubChannelObjects } = useGraffitiDiscover(
    () => [settingsClubDiscoverChannel.value],
    messageChannelObjectSchema,
    undefined,
    true,
  );

  /** When directory BookClub updates lag, the winning title still lives on the club channel. */
  const closedPollWinnerTitle = computed(() => {
    if (!clubChannelFromRoute.value) return "";
    const objects =
      route.name === "chat-settings"
        ? rawSettingsClubChannelObjects.value
        : rawChannelObjects.value;
    const winners = objects
      .filter(
        (o) =>
          o.value?.type === "BookPollClosed" &&
          typeof o.value?.winnerTitle === "string" &&
          String(o.value.winnerTitle).trim(),
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
    return String(winners[0]?.value?.winnerTitle ?? "").trim();
  });

  const mergedClubNextBook = computed(() => {
    const fromDir = String(clubForActiveChat.value?.value?.nextBook ?? "").trim();
    return fromDir || closedPollWinnerTitle.value;
  });

  const activeClubSettings = computed(() => {
    const value = clubForActiveChat.value?.value;
    if (!value) return null;
    return {
      name: value.name ?? "",
      nextMeetingAt: value.nextMeetingAt ?? "",
      nextMeetingLocation: value.nextMeetingLocation ?? "",
      allowedGenres: value.allowedGenres ?? "",
      nextBook: mergedClubNextBook.value,
    };
  });

  /** ClubMembership objects for a club channel, from any discover source. */
  function clubMembershipObjectsForChannel(objects, channelId) {
    const ch = String(channelId ?? "");
    if (!ch) return [];
    return objects.filter(
      (o) =>
        o.value?.type === "ClubMembership" && String(o.value?.channel ?? "") === ch,
    );
  }

  function hasClubChannelJoinMirror(actor, channelId) {
    const ch = String(channelId ?? "");
    const a = typeof actor === "string" ? actor : "";
    if (!ch || !a) return false;
    const objects =
      clubChannelFromRoute.value === ch && route.name === "chat-settings"
        ? rawSettingsClubChannelObjects.value
        : rawChannelObjects.value;
    return objects.some(
      (o) =>
        o.actor === a &&
        o.value?.type === "ClubMembership" &&
        o.value?.activity === "Join" &&
        String(o.value?.channel ?? "") === ch,
    );
  }

  /**
   * Actors currently in the club: directory owner + latest Join per reader.
   * Join/Leave is posted to each member's profile and mirrored on the club channel so every
   * client can see the roster. Late joiners who only have an older profile-only Join get a
   * mirror posted when they open this chat (see club join mirror watch).
   */
  function memberActorSetForChannel(channelId) {
    const ch = String(channelId ?? "");
    if (!ch) return new Set();
    const actors = new Set();
    const club = sortedClubs.value.find((c) => c.value?.channel === ch);
    const owner = club?.value?.ownerActor ?? club?.actor;
    if (typeof owner === "string" && owner.trim()) actors.add(owner.trim());
    const onClubChannel = clubMembershipObjectsForChannel(rawChannelObjects.value, ch);
    const onProfile = clubMembershipObjectsForChannel(rawMembershipObjects.value, ch);
    const events = [...onClubChannel, ...onProfile].toSorted(
      (a, b) => (a.value.published ?? 0) - (b.value.published ?? 0),
    );
    const latestByActor = new Map();
    for (const e of events) {
      const a = typeof e.actor === "string" ? e.actor : "";
      if (!a) continue;
      latestByActor.set(a, e.value?.activity === "Join");
    }
    for (const [a, joined] of latestByActor) {
      if (joined) actors.add(a);
    }
    return actors;
  }

  const clubJoinMirrorInFlight = ref(null);

  watch(
    () => [
      route.name,
      activeClubChannel.value,
      session.value?.actor,
      messagesLoading.value,
      clubChannelFromRoute.value,
      myClubMembershipByChannel.value,
    ],
    async () => {
      if (route.name !== "chat" && route.name !== "chat-poll") return;
      const ch = activeClubChannel.value;
      const actor = session.value?.actor;
      if (!ch || !actor || !session.value) return;
      if (messagesLoading.value) return;
      if (clubJoinMirrorInFlight.value === ch) return;
      if (!isMemberOfClub(ch)) return;
      const profileJoined = myClubMembershipByChannel.value.get(ch) === true;
      const isOwner = activeClubOwnerActor.value && session.value.actor === activeClubOwnerActor.value;
      if (!profileJoined && !isOwner) return;
      if (hasClubChannelJoinMirror(actor, ch)) return;
      clubJoinMirrorInFlight.value = ch;
      try {
        await graffiti.post(
          {
            value: {
              type: "ClubMembership",
              activity: "Join",
              channel: ch,
              published: Date.now(),
            },
            channels: [ch],
          },
          session.value,
        );
      } catch {
        /* retry on a later navigation / discover tick */
      } finally {
        clubJoinMirrorInFlight.value = null;
      }
    },
    { flush: "post" },
  );

  const sortedMessages = computed(() => {
    const list = rawChannelObjects.value.filter(
      (o) => o.value?.type === "Note" && o.value?.content != null,
    );
    return list.toSorted(
      (a, b) => (a.value.published ?? 0) - (b.value.published ?? 0),
    );
  });

  const messageThreadActive = computed(
    () =>
      activeClubChannel.value != null ||
      (route.name === "dm" && dmPeerActor.value != null && !dmSelfConversation.value),
  );

  const isMessageThreadLoading = computed(
    () => messageThreadActive.value && messagesLoading.value,
  );

  const BOOK_POLL_DURATION_MS = 24 * 60 * 60 * 1000;

  function tallyBookPollVotes(pollId) {
    const votes = rawChannelObjects.value
      .filter((o) => o.value?.type === "BookPollVote" && o.value?.pollId === pollId)
      .toSorted((a, b) => (a.value.published ?? 0) - (b.value.published ?? 0));
    const latestByActor = new Map();
    for (const v of votes) {
      const actor = typeof v.actor === "string" ? v.actor.trim() : "";
      const oid = v.value?.optionId;
      if (!actor || typeof oid !== "string" || !oid) continue;
      latestByActor.set(actor, oid);
    }
    const counts = new Map();
    for (const oid of latestByActor.values()) {
      counts.set(oid, (counts.get(oid) ?? 0) + 1);
    }
    return { counts, latestByActor };
  }

  const closedPollIds = computed(() => {
    const s = new Set();
    for (const o of rawChannelObjects.value) {
      const pid = o.value?.pollId;
      if (o.value?.type === "BookPollClosed" && typeof pid === "string" && pid) s.add(pid);
    }
    return s;
  });

  const latestOpenBookPoll = computed(() => {
    if (!activeClubChannel.value) return null;
    const polls = rawChannelObjects.value
      .filter(
        (o) =>
          o.value?.type === "BookPoll" &&
          typeof o.value?.pollId === "string" &&
          Array.isArray(o.value?.options) &&
          o.value.options.length >= 2,
      )
      .toSorted((a, b) => (b.value.published ?? 0) - (a.value.published ?? 0));
    const closed = closedPollIds.value;
    for (const p of polls) {
      if (closed.has(p.value.pollId)) continue;
      return p;
    }
    return null;
  });

  const pollUiTick = ref(Date.now());
  watchEffect((onCleanup) => {
    const poll = latestOpenBookPoll.value;
    const pid = poll?.value?.pollId;
    if (!pid || closedPollIds.value.has(pid)) return;
    const id = window.setInterval(() => {
      pollUiTick.value = Date.now();
    }, 15_000);
    onCleanup(() => window.clearInterval(id));
  });

  const activePollEndsAtMs = computed(() => {
    pollUiTick.value;
    const p = latestOpenBookPoll.value?.value;
    if (!p) return null;
    if (Number.isFinite(p.endsAt)) return p.endsAt;
    return (p.published ?? 0) + BOOK_POLL_DURATION_MS;
  });

  const activeClubPollMemberActors = computed(() => {
    const ch = activeClubChannel.value;
    if (!ch) return new Set();
    const s = memberActorSetForChannel(ch);
    const owner = activeClubOwnerActor.value;
    if (typeof owner === "string" && owner.trim()) s.add(owner.trim());
    const self = session.value?.actor;
    if (typeof self === "string" && self.trim() && isMemberOfClub(ch)) {
      s.add(self.trim());
    }
    return s;
  });

  const activePollAllMembersHaveVoted = computed(() => {
    const poll = latestOpenBookPoll.value;
    if (!poll?.value?.pollId) return false;
    const members = activeClubPollMemberActors.value;
    if (members.size === 0) return false;
    const tally = tallyBookPollVotes(poll.value.pollId);
    // More distinct voters than known members ⇒ roster is missing someone (e.g. late joiner
    // not mirrored yet); do not treat the poll as unanimous.
    if (tally.latestByActor.size > members.size) return false;
    for (const actor of members) {
      if (!tally.latestByActor.has(actor)) return false;
    }
    return true;
  });

  const activeClubPollMemberCount = computed(() => activeClubPollMemberActors.value.size);

  const activePollVoteTurnout = computed(() => {
    const poll = latestOpenBookPoll.value;
    const members = activeClubPollMemberActors.value;
    if (!poll?.value?.pollId || members.size === 0) return { voted: 0, total: 0 };
    const tally = tallyBookPollVotes(poll.value.pollId);
    let voted = 0;
    for (const a of members) {
      if (tally.latestByActor.has(a)) voted++;
    }
    return { voted, total: members.size };
  });

  const pollVotingOpen = computed(() => {
    pollUiTick.value;
    const ends = activePollEndsAtMs.value;
    if (ends == null) return false;
    if (Date.now() >= ends) return false;
    if (activePollAllMembersHaveVoted.value) return false;
    return true;
  });

  const activePollAwaitingOwnerFinalize = computed(
    () =>
      Boolean(
        latestOpenBookPoll.value && !pollVotingOpen.value && userCanManageActiveClub.value,
      ),
  );

  const activePollWaitingForOwnerFinalize = computed(
    () =>
      Boolean(
        latestOpenBookPoll.value &&
          !pollVotingOpen.value &&
          !userCanManageActiveClub.value &&
          activePollHasTie.value,
      ),
  );

  const activePollOptions = computed(() => {
    const poll = latestOpenBookPoll.value?.value;
    if (!poll?.options) return [];
    return poll.options.filter(
      (o) => o && typeof o.id === "string" && String(o.title ?? "").trim(),
    );
  });

  const activePollTally = computed(() => {
    const poll = latestOpenBookPoll.value;
    if (!poll?.value?.pollId) return null;
    return tallyBookPollVotes(poll.value.pollId);
  });

  const activePollLeaders = computed(() => {
    const tally = activePollTally.value;
    const opts = activePollOptions.value;
    if (!opts.length) return { max: 0, optionIds: [] };
    let max = 0;
    if (tally && tally.counts.size > 0) {
      for (const n of tally.counts.values()) if (n > max) max = n;
    }
    if (max > 0) {
      const optionIds = [...tally.counts.entries()].filter(([, n]) => n === max).map(([id]) => id);
      return { max, optionIds };
    }
    return { max: 0, optionIds: opts.map((o) => o.id) };
  });

  const activePollHasTie = computed(() => activePollLeaders.value.optionIds.length > 1);

  const myActivePollVoteOptionId = computed(() => {
    const poll = latestOpenBookPoll.value;
    const actor = typeof session.value?.actor === "string" ? session.value.actor.trim() : "";
    if (!poll?.value?.pollId || !actor) return "";
    return tallyBookPollVotes(poll.value.pollId).latestByActor.get(actor) ?? "";
  });

  watch(
    () => [latestOpenBookPoll.value?.value?.pollId ?? "", myActivePollVoteOptionId.value],
    ([pollId, serverVote], prev) => {
      const prevPollId = Array.isArray(prev) ? (prev[0] ?? "") : "";
      const prevServer = Array.isArray(prev) ? (prev[1] ?? "") : "";
      if (pollId !== prevPollId) {
        pollVoteSelection.value = serverVote || "";
        tieBreakOptionId.value = "";
        pollFinalizeError.value = "";
        pollVoteError.value = "";
        return;
      }
      if (serverVote !== prevServer) {
        if (serverVote) {
          pollVoteSelection.value = serverVote;
          pollVoteError.value = "";
        } else if (prevServer) {
          pollVoteSelection.value = "";
        }
      }
    },
    { immediate: true },
  );

  const activePollPreviewOption = computed(() => {
    const id = pollVoteSelection.value;
    if (!id) return null;
    return activePollOptions.value.find((o) => o.id === id) ?? null;
  });

  function scrollMessagesToLatest() {
    const el = messageViewportRef.value;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  watch(
    () => [route.name, route.params.chatId, route.params.peerKey],
    async () => {
      await nextTick();
      scrollMessagesToLatest();
    },
  );

  watch(
    () => sortedMessages.value.length,
    async () => {
      await nextTick();
      scrollMessagesToLatest();
    },
  );

  function dismissProfileError() {
    profileError.value = "";
  }

  function normalizeBookStatus(status) {
    if (status === "finished" || status === "dnf") return status;
    return "reading";
  }

  function parseDraftPage(value) {
    const parsed = parseInt(String(value ?? "").trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeIsbn(raw) {
    return String(raw ?? "")
      .toUpperCase()
      .replace(/[^0-9X]/g, "");
  }

  function isValidIsbn10(isbn) {
    if (!/^\d{9}[\dX]$/.test(isbn)) return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += (i + 1) * Number(isbn[i]);
    }
    const checksumChar = isbn[9];
    const checksum = checksumChar === "X" ? 10 : Number(checksumChar);
    sum += 10 * checksum;
    return sum % 11 === 0;
  }

  function isValidIsbn13(isbn) {
    if (!/^\d{13}$/.test(isbn)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const digit = Number(isbn[i]);
      sum += i % 2 === 0 ? digit : digit * 3;
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return checkDigit === Number(isbn[12]);
  }

  function isValidIsbn(raw) {
    const normalized = normalizeIsbn(raw);
    if (!normalized) return true;
    return isValidIsbn10(normalized) || isValidIsbn13(normalized);
  }

  function setBookPageDraft(url, value) {
    bookPageDrafts.value = {
      ...bookPageDrafts.value,
      [url]: value == null || value === "" ? "" : String(value),
    };
  }

  function ensureBookPageDraft(entry) {
    if (!entry?.url) return;
    if (Object.prototype.hasOwnProperty.call(bookPageDrafts.value, entry.url)) return;
    setBookPageDraft(entry.url, entry.value?.currentPage ?? "");
  }

  async function replaceCurrentlyReadingEntry(entry, patch = {}) {
    if (!session.value || entry.actor !== session.value.actor) return;
    profileError.value = "";
    const pending = new Set(isUpdatingBook.value);
    pending.add(entry.url);
    isUpdatingBook.value = pending;
    try {
      const currentPageInput =
        patch.currentPage ?? parseDraftPage(bookPageDrafts.value[entry.url] ?? entry.value?.currentPage);
      const totalPages =
        Number.isFinite(entry.value?.totalPages) && entry.value.totalPages >= 0
          ? entry.value.totalPages
          : null;
      if (currentPageInput != null && currentPageInput < 0) {
        profileError.value = "Current page cannot be negative.";
        return;
      }
      if (
        currentPageInput != null &&
        Number.isFinite(totalPages) &&
        totalPages > 0 &&
        currentPageInput > totalPages
      ) {
        profileError.value = "Current page cannot be greater than total pages.";
        return;
      }
      const nextStatus = normalizeBookStatus(patch.status ?? entry.value?.status);
      const nextValue = {
        type: "CurrentlyReading",
        title: String(entry.value?.title ?? "").trim(),
        published: Date.now(),
        status: nextStatus,
        statusUpdatedAt: Date.now(),
      };
      const isbn = String(entry.value?.isbn ?? "").trim();
      if (isbn) nextValue.isbn = isbn;
      if (currentPageInput != null) nextValue.currentPage = currentPageInput;
      if (Number.isFinite(totalPages)) nextValue.totalPages = totalPages;

      await graffiti.post(
        {
          value: nextValue,
          channels: [profileChannel.value],
        },
        session.value,
      );
      await graffiti.delete(entry, session.value);
      setBookPageDraft(entry.url, nextValue.currentPage ?? "");
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not update this book on your profile.";
    } finally {
      const done = new Set(isUpdatingBook.value);
      done.delete(entry.url);
      isUpdatingBook.value = done;
    }
  }

  function updateCurrentPage(entry) {
    return replaceCurrentlyReadingEntry(entry);
  }

  function markBookFinished(entry) {
    const totalPages =
      Number.isFinite(entry.value?.totalPages) && entry.value.totalPages > 0 ? entry.value.totalPages : null;
    const patch = { status: "finished" };
    if (totalPages != null) patch.currentPage = totalPages;
    return replaceCurrentlyReadingEntry(entry, patch);
  }

  function markBookDnf(entry) {
    return replaceCurrentlyReadingEntry(entry, { status: "dnf" });
  }

  function markBookReading(entry) {
    return replaceCurrentlyReadingEntry(entry, { status: "reading" });
  }

  async function addCurrentlyReadingBook() {
    const title = newBookTitle.value.trim();
    if (!title || !session.value) return;
    profileError.value = "";
    const currentPage = parseInt(String(newBookCurrentPage.value).trim(), 10);
    const totalPages = parseInt(String(newBookTotalPages.value).trim(), 10);
    if (
      (Number.isFinite(currentPage) && currentPage < 0) ||
      (Number.isFinite(totalPages) && totalPages < 0)
    ) {
      profileError.value = "Page counts cannot be negative.";
      return;
    }
    if (
      Number.isFinite(currentPage) &&
      Number.isFinite(totalPages) &&
      totalPages > 0 &&
      currentPage > totalPages
    ) {
      profileError.value = "Current page cannot be greater than total pages.";
      return;
    }
    if (!isValidIsbn(newBookIsbn.value)) {
      profileError.value = "ISBN must be a valid ISBN-10 or ISBN-13.";
      return;
    }
    isAddingBook.value = true;
    try {
      const value = {
        type: "CurrentlyReading",
        title,
        status: "reading",
        statusUpdatedAt: Date.now(),
        published: Date.now(),
      };
      const isbn = normalizeIsbn(newBookIsbn.value);
      if (isbn) value.isbn = isbn;
      if (Number.isFinite(currentPage)) value.currentPage = currentPage;
      if (Number.isFinite(totalPages)) value.totalPages = totalPages;
      await graffiti.post(
        {
          value,
          channels: [profileChannel.value],
        },
        session.value,
      );
      newBookTitle.value = "";
      newBookIsbn.value = "";
      newBookCurrentPage.value = "";
      newBookTotalPages.value = "";
      showAddBookForm.value = false;
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not add this book to your profile.";
    } finally {
      isAddingBook.value = false;
    }
  }

  async function removeCurrentlyReadingBook(entry) {
    if (!session.value || entry.actor !== session.value.actor) return;
    const title = String(entry?.value?.title ?? "this book");
    const confirmed = confirm(`Remove "${title}" from your profile?`);
    if (!confirmed) return;
    profileError.value = "";
    const next = new Set(isRemovingBook.value);
    next.add(entry.url);
    isRemovingBook.value = next;
    try {
      await graffiti.delete(entry, session.value);
    } catch (e) {
      profileError.value =
        e instanceof Error ? e.message : "Could not remove this book from your profile.";
    } finally {
      const done = new Set(isRemovingBook.value);
      done.delete(entry.url);
      isRemovingBook.value = done;
    }
  }

  async function createBookClub() {
    const name = newClubName.value.trim();
    if (!name || !session.value) return;
    if (isClubNameTaken(name)) {
      createClubError.value = "A club with this title already exists. Choose a unique title.";
      return;
    }
    createClubError.value = "";
    isCreatingClub.value = true;
    const channel = crypto.randomUUID();
    try {
      await graffiti.post(
        {
          value: {
            activity: "Create",
            type: "BookClub",
            name,
            channel,
            ownerActor: session.value.actor,
            nextMeetingAt: "",
            nextMeetingLocation: "",
            allowedGenres: "",
            nextBook: "",
            published: Date.now(),
          },
          channels: [BOOK_CLUB_DIRECTORY],
        },
        session.value,
      );
      await graffiti.post(
        {
          value: {
            type: "ClubMembership",
            activity: "Join",
            channel,
            published: Date.now(),
          },
          channels: [profileChannel.value, channel],
        },
        session.value,
      );
      newClubName.value = "";
      if (route.name === "join") {
        await router.push({ name: "clubs" });
      }
    } catch (e) {
      createClubError.value =
        e instanceof Error ? e.message : "Could not create this book club.";
    } finally {
      isCreatingClub.value = false;
    }
  }

  watch(
    () => [clubForActiveChat.value?.url, mergedClubNextBook.value],
    () => {
      const settings = activeClubSettings.value;
      clubSettingsName.value = settings?.name ?? "";
      clubSettingsNextMeetingAt.value = settings?.nextMeetingAt ?? "";
      clubSettingsNextMeetingLocation.value = settings?.nextMeetingLocation ?? "";
      clubSettingsAllowedGenres.value = settings?.allowedGenres ?? "";
      clubSettingsNextBook.value = settings?.nextBook ?? "";
      showClubSettingsEditor.value = false;
      clubSettingsError.value = "";
    },
    { immediate: true },
  );

  function toggleClubSettingsEditor() {
    if (!userCanManageActiveClub.value) return;
    showClubSettingsEditor.value = !showClubSettingsEditor.value;
    if (!showClubSettingsEditor.value) {
      const settings = activeClubSettings.value;
      clubSettingsName.value = settings?.name ?? "";
      clubSettingsNextMeetingAt.value = settings?.nextMeetingAt ?? "";
      clubSettingsNextMeetingLocation.value = settings?.nextMeetingLocation ?? "";
      clubSettingsAllowedGenres.value = settings?.allowedGenres ?? "";
      clubSettingsNextBook.value = settings?.nextBook ?? "";
    }
    clubSettingsError.value = "";
  }
  async function saveActiveClubSettings() {
    if (!session.value || !clubForActiveChat.value || !userCanManageActiveClub.value) return;
    const name = clubSettingsName.value.trim();
    if (!name) {
      clubSettingsError.value = "Club name cannot be empty.";
      return;
    }
    if (isClubNameTaken(name, clubForActiveChat.value.value.channel)) {
      clubSettingsError.value = "A club with this title already exists. Choose a unique title.";
      return;
    }
    clubSettingsError.value = "";
    isSavingClubSettings.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Update",
            type: "BookClub",
            channel: clubForActiveChat.value.value.channel,
            name,
            ownerActor: activeClubOwnerActor.value,
            nextMeetingAt: clubSettingsNextMeetingAt.value.trim(),
            nextMeetingLocation: clubSettingsNextMeetingLocation.value.trim(),
            allowedGenres: clubSettingsAllowedGenres.value.trim(),
            nextBook: clubSettingsNextBook.value.trim(),
            published: Date.now(),
          },
          channels: [BOOK_CLUB_DIRECTORY],
        },
        session.value,
      );
    } catch (e) {
      clubSettingsError.value =
        e instanceof Error ? e.message : "Could not save club settings.";
    } finally {
      isSavingClubSettings.value = false;
    }
  }

  async function deleteActiveClub() {
    if (!session.value || !clubForActiveChat.value || !userCanManageActiveClub.value) return;
    clubSettingsError.value = "";
    isDeletingClub.value = true;
    try {
      await graffiti.post(
        {
          value: {
            activity: "Delete",
            type: "BookClub",
            channel: clubForActiveChat.value.value.channel,
            ownerActor: activeClubOwnerActor.value,
            published: Date.now(),
          },
          channels: [BOOK_CLUB_DIRECTORY],
        },
        session.value,
      );
      await router.push({ name: "clubs" });
    } catch (e) {
      clubSettingsError.value =
        e instanceof Error ? e.message : "Could not delete this book club.";
    } finally {
      isDeletingClub.value = false;
    }
  }

  async function joinClub(channel) {
    if (!session.value || !channel) return;
    createClubError.value = "";
    const next = new Set(isUpdatingMembership.value);
    next.add(channel);
    isUpdatingMembership.value = next;
    try {
      await graffiti.post(
        {
          value: {
            type: "ClubMembership",
            activity: "Join",
            channel,
            published: Date.now(),
          },
          channels: [profileChannel.value, channel],
        },
        session.value,
      );
      const onThisClub =
        (route.name === "chat" ||
          route.name === "chat-settings" ||
          route.name === "chat-poll") &&
        String(route.params.chatId) === channel;
      if (!onThisClub) {
        await router.push({ name: "chat", params: { chatId: channel } });
      }
    } catch (e) {
      createClubError.value = e instanceof Error ? e.message : "Could not join this club.";
    } finally {
      const done = new Set(isUpdatingMembership.value);
      done.delete(channel);
      isUpdatingMembership.value = done;
    }
  }

  async function leaveActiveClub() {
    const channel = clubChannelFromRoute.value;
    if (!session.value || !channel) return;
    const club = sortedClubs.value.find((c) => c.value?.channel === channel);
    if (club?.value?.ownerActor === session.value.actor) {
      clubSettingsError.value = "Owners cannot leave their own club.";
      return;
    }
    const confirmed = confirm("Leave this book club? You can rejoin later from the clubs list.");
    if (!confirmed) return;
    clubSettingsError.value = "";
    const pending = new Set(isUpdatingMembership.value);
    pending.add(channel);
    isUpdatingMembership.value = pending;
    try {
      await graffiti.post(
        {
          value: {
            type: "ClubMembership",
            activity: "Leave",
            channel,
            published: Date.now(),
          },
          channels: [profileChannel.value, channel],
        },
        session.value,
      );
      await router.push({ name: "clubs" });
    } catch (e) {
      clubSettingsError.value = e instanceof Error ? e.message : "Could not leave this club.";
    } finally {
      const done = new Set(isUpdatingMembership.value);
      done.delete(channel);
      isUpdatingMembership.value = done;
    }
  }

  function toggleReveal(url) {
    const next = new Set(revealedMessageUrls.value);
    if (next.has(url)) next.delete(url);
    else next.add(url);
    revealedMessageUrls.value = next;
  }

  function spoilerRevealInfo(msg) {
    if (!msg?.value?.isBlurred) return "";
    const parts = [];
    const warning = String(msg.value.spoilerWarning ?? "").trim();
    if (warning) parts.push(`Warning: ${warning}`);
    if (Number.isFinite(msg.value?.spoilerPage)) {
      parts.push(`Spoiler threshold page: ${msg.value.spoilerPage}`);
    }
    if (Number.isFinite(msg.value?.spoilerProgress)) {
      parts.push(`Spoiler threshold progress: ${Math.round(msg.value.spoilerProgress * 100)}%`);
    }
    return parts.join("\n");
  }

  function toggleRevealWithAlert(msg) {
    const isCurrentlyHidden = !revealedMessageUrls.value.has(msg.url);
    if (isCurrentlyHidden) {
      const info = spoilerRevealInfo(msg);
      if (info) {
        alert(`Spoiler info:\n${info}`);
      }
    }
    toggleReveal(msg.url);
  }

  function addPollDraftRow() {
    if (pollDraftRows.value.length >= 5) return;
    pollDraftRows.value = [
      ...pollDraftRows.value,
      { title: "", isbn: "", synopsis: "", totalPages: "" },
    ];
  }

  function removePollDraftRow(idx) {
    if (pollDraftRows.value.length <= 2) return;
    pollDraftRows.value = pollDraftRows.value.filter((_, i) => i !== idx);
    pollOlTargetRow.value = Math.min(pollOlTargetRow.value, pollDraftRows.value.length - 1);
  }

  async function runPollOpenLibrarySearch() {
    const q = pollOlQuery.value.trim();
    pollOlError.value = "";
    pollOlHits.value = [];
    if (!q) {
      pollOlError.value = "Enter a title or author.";
      return;
    }
    pollOlAbort.value?.abort();
    const ctl = new AbortController();
    pollOlAbort.value = ctl;
    pollOlSearching.value = true;
    try {
      pollOlHits.value = await searchOpenLibraryBooks(q, ctl.signal);
      if (!pollOlHits.value.length) pollOlError.value = "No results.";
    } catch (e) {
      if (e && typeof e === "object" && "name" in e && e.name === "AbortError") return;
      pollOlError.value = e instanceof Error ? e.message : "Search failed.";
    } finally {
      pollOlSearching.value = false;
    }
  }

  async function applyPollOpenLibraryHit(hit) {
    if (!hit) return;
    const i = pollOlTargetRow.value;
    const rows = [...pollDraftRows.value];
    if (!rows[i]) return;
    rows[i] = {
      ...rows[i],
      title: String(hit.title ?? "").trim(),
      isbn: String(hit.isbn ?? "").trim(),
      totalPages:
        hit.totalPages != null && hit.totalPages > 0 ? String(hit.totalPages) : rows[i].totalPages,
      synopsis: String(hit.synopsisHint ?? "").trim() || rows[i].synopsis,
    };
    pollDraftRows.value = rows;
    pollOlHits.value = [];
    pollOlError.value = "";
    if (hit.isbn) {
      try {
        const meta = await fetchOpenLibraryEditionByIsbn(hit.isbn, undefined);
        const r = { ...pollDraftRows.value[i] };
        if (meta.title) r.title = meta.title;
        if (meta.synopsis) r.synopsis = meta.synopsis;
        if (meta.totalPages != null && meta.totalPages > 0) r.totalPages = String(meta.totalPages);
        const next = [...pollDraftRows.value];
        next[i] = r;
        pollDraftRows.value = next;
      } catch {
        /* edition fetch is best-effort */
      }
    }
  }

  async function enrichPollRowFromIsbn(rowIndex) {
    const row = pollDraftRows.value[rowIndex];
    if (!row?.isbn?.trim()) {
      pollOlError.value = "Enter an ISBN on that row first.";
      return;
    }
    pollOlError.value = "";
    try {
      const meta = await fetchOpenLibraryEditionByIsbn(row.isbn, undefined);
      const next = [...pollDraftRows.value];
      const r = { ...next[rowIndex] };
      if (meta.title) r.title = meta.title;
      if (meta.synopsis) r.synopsis = meta.synopsis;
      if (meta.totalPages != null && meta.totalPages > 0) r.totalPages = String(meta.totalPages);
      next[rowIndex] = r;
      pollDraftRows.value = next;
    } catch (e) {
      pollOlError.value = e instanceof Error ? e.message : "Lookup failed.";
    }
  }

  async function submitCreateBookPoll() {
    pollComposerError.value = "";
    if (!session.value || !userCanManageActiveClub.value || !activeClubChannel.value) return;
    if (latestOpenBookPoll.value) {
      pollComposerError.value = "There is already an open poll. Close it before starting a new one.";
      return;
    }
    const built = [];
    for (const row of pollDraftRows.value) {
      const title = String(row.title ?? "").trim();
      if (!title) continue;
      const isbn = normalizeIsbn(row.isbn ?? "");
      const syn = String(row.synopsis ?? "").trim();
      let totalPages = null;
      const tp = parseInt(String(row.totalPages ?? "").trim(), 10);
      if (Number.isFinite(tp) && tp > 0) totalPages = tp;
      built.push({
        id: crypto.randomUUID(),
        title,
        ...(isbn ? { isbn } : {}),
        ...(Number.isFinite(totalPages) ? { totalPages } : {}),
        ...(syn ? { synopsis: syn.slice(0, 5000) } : {}),
      });
    }
    if (built.length < 2) {
      pollComposerError.value = "Add at least two books with titles.";
      return;
    }
    isPostingBookPoll.value = true;
    try {
      const pollId = crypto.randomUUID();
      const endsAt = Date.now() + BOOK_POLL_DURATION_MS;
      await graffiti.post(
        {
          value: {
            type: "BookPoll",
            pollId,
            endsAt,
            options: built,
            published: Date.now(),
          },
          channels: [activeClubChannel.value],
        },
        session.value,
      );
      showBookPollComposer.value = false;
      pollDraftRows.value = [
        { title: "", isbn: "", synopsis: "", totalPages: "" },
        { title: "", isbn: "", synopsis: "", totalPages: "" },
      ];
      pollOlQuery.value = "";
      pollOlHits.value = [];
    } catch (e) {
      pollComposerError.value =
        e instanceof Error ? e.message : "Poll could not be created.";
    } finally {
      isPostingBookPoll.value = false;
    }
  }

  async function submitBookPollVote() {
    pollVoteError.value = "";
    const channel = activeClubChannel.value;
    const poll = latestOpenBookPoll.value;
    const optionId = pollVoteSelection.value.trim();
    if (!session.value || !channel || !poll?.value?.pollId || !optionId) {
      pollVoteError.value = "Choose a book to vote for.";
      return;
    }
    if (!isMemberOfClub(channel)) {
      pollVoteError.value = "You must be a member to vote.";
      return;
    }
    if (!pollVotingOpen.value) {
      pollVoteError.value = "Voting has ended for this poll.";
      return;
    }
    const ids = new Set(activePollOptions.value.map((o) => o.id));
    if (!ids.has(optionId)) {
      pollVoteError.value = "That option is not part of this poll.";
      return;
    }
    isSubmittingPollVote.value = true;
    try {
      await graffiti.post(
        {
          value: {
            type: "BookPollVote",
            pollId: poll.value.pollId,
            optionId,
            published: Date.now(),
          },
          channels: [channel],
        },
        session.value,
      );
    } catch (e) {
      pollVoteError.value =
        e instanceof Error ? e.message : "Could not record your vote.";
    } finally {
      isSubmittingPollVote.value = false;
    }
  }

  async function applyPollWinnerAndCloseChannel(poll, winnerOptionId) {
    if (!session.value || !userCanManageActiveClub.value || !activeClubChannel.value) {
      throw new Error("Not allowed.");
    }
    const pid = poll?.value?.pollId;
    if (!pid || closedPollIds.value.has(pid)) return;
    const club = clubForActiveChat.value;
    if (!club?.value) throw new Error("Club data not loaded.");
    const v = club.value;
    const optionById = new Map(
      (Array.isArray(poll.value?.options) ? poll.value.options : []).map((o) => [o.id, o]),
    );
    const winnerTitle = String(optionById.get(winnerOptionId)?.title ?? "").trim();
    if (!winnerTitle) throw new Error("Could not read the winning title.");
    const name = String(v.name ?? "").trim();
    if (!name) throw new Error("Club name missing.");
    if (isClubNameTaken(name, v.channel)) {
      throw new Error("Resolve the duplicate club name in settings before finalizing.");
    }
    await graffiti.post(
      {
        value: {
          activity: "Update",
          type: "BookClub",
          channel: v.channel,
          name,
          ownerActor: activeClubOwnerActor.value,
          nextMeetingAt: String(v.nextMeetingAt ?? "").trim(),
          nextMeetingLocation: String(v.nextMeetingLocation ?? "").trim(),
          allowedGenres: String(v.allowedGenres ?? "").trim(),
          nextBook: winnerTitle,
          published: Date.now(),
        },
        channels: [BOOK_CLUB_DIRECTORY],
      },
      session.value,
    );
    await graffiti.post(
      {
        value: {
          type: "BookPollClosed",
          pollId: pid,
          winnerOptionId,
          winnerTitle,
          published: Date.now(),
        },
        channels: [activeClubChannel.value],
      },
      session.value,
    );
    tieBreakOptionId.value = "";
  }

  function resolvePollWinnerOptionId() {
    const leaders = activePollLeaders.value;
    if (leaders.optionIds.length === 1) return leaders.optionIds[0];
    const pick = tieBreakOptionId.value.trim();
    if (pick && leaders.optionIds.includes(pick)) return pick;
    return "";
  }

  async function finalizeBookPoll() {
    pollFinalizeError.value = "";
    if (!session.value || !userCanManageActiveClub.value || !activeClubChannel.value) return;
    const poll = latestOpenBookPoll.value;
    if (!poll?.value?.pollId) {
      pollFinalizeError.value = "No open poll.";
      return;
    }
    if (closedPollIds.value.has(poll.value.pollId)) return;
    const ends = activePollEndsAtMs.value;
    const timeUp = ends != null && Date.now() >= ends;
    const allIn = activePollAllMembersHaveVoted.value;
    if (!timeUp && !allIn) {
      pollFinalizeError.value =
        "Voting is still open. Wait for the deadline or until every member has voted.";
      return;
    }
    const winnerOptionId = resolvePollWinnerOptionId();
    if (!winnerOptionId) {
      pollFinalizeError.value = "Choose the winning book to break the tie.";
      return;
    }
    isFinalizingPoll.value = true;
    try {
      await applyPollWinnerAndCloseChannel(poll, winnerOptionId);
      pollAutoCloseLastId.value = poll.value.pollId;
    } catch (e) {
      pollFinalizeError.value =
        e instanceof Error ? e.message : "Could not finalize this poll.";
    } finally {
      isFinalizingPoll.value = false;
    }
  }

  watch(
    () => [
      session.value?.actor,
      userCanManageActiveClub.value,
      latestOpenBookPoll.value?.value?.pollId,
      pollVotingOpen.value,
      activePollHasTie.value,
      activePollLeaders.value.optionIds.join("\u0000"),
    ],
    async () => {
      if (!session.value || !userCanManageActiveClub.value) return;
      const poll = latestOpenBookPoll.value;
      const pid = poll?.value?.pollId;
      if (!pid || closedPollIds.value.has(pid)) return;
      if (pollVotingOpen.value) return;
      if (activePollHasTie.value) return;
      const leaders = activePollLeaders.value;
      if (leaders.optionIds.length !== 1) return;
      if (pollAutoCloseLastId.value === pid) return;
      if (pollAutoClosingInFlight.value) return;
      if (isFinalizingPoll.value) return;
      pollAutoClosingInFlight.value = true;
      isFinalizingPoll.value = true;
      try {
        await applyPollWinnerAndCloseChannel(poll, leaders.optionIds[0]);
        pollAutoCloseLastId.value = pid;
      } catch {
        pollAutoCloseLastId.value = "";
      } finally {
        isFinalizingPoll.value = false;
        pollAutoClosingInFlight.value = false;
      }
    },
  );

  function pollVoteCountFor(optionId) {
    return activePollTally.value?.counts.get(optionId) ?? 0;
  }

  function getActivePollOptionTitle(optionId) {
    return activePollOptions.value.find((o) => o.id === optionId)?.title ?? "";
  }

  async function sendMessage() {
    const text = myMessage.value.trim();
    const channel = selectedMessageChannel.value;
    if (!text || !session.value || !channel || channel === IDLE_MESSAGE_CHANNEL) return;
    sendError.value = "";
    isSending.value = true;
    try {
      const value = {
        type: "Note",
        content: text,
        published: Date.now(),
      };
      const book = markAsSpoiler.value ? contextBook.value.trim() : "";
      if (book) value.contextBook = book;
      if (markAsSpoiler.value) {
        value.isBlurred = true;
        value.spoilerWarning = spoilerWarning.value.trim() || "Spoiler";
        const parsedSpoilerPage = parseInt(String(spoilerPage.value).trim(), 10);
        const parsedSpoilerProgress = parseFloat(String(spoilerProgressPercent.value).trim());
        if (Number.isFinite(parsedSpoilerPage) && parsedSpoilerPage > 0) {
          value.spoilerPage = parsedSpoilerPage;
        }
        if (Number.isFinite(parsedSpoilerProgress) && parsedSpoilerProgress >= 0 && parsedSpoilerProgress <= 100) {
          value.spoilerProgress = parsedSpoilerProgress / 100;
        } else if (String(spoilerProgressPercent.value).trim()) {
          sendError.value = "Spoiler progress must be between 0 and 100 percent.";
          return;
        }
      } else {
        value.isBlurred = false;
        value.spoilerWarning = "";
      }
      await graffiti.post(
        {
          value,
          channels: [channel],
        },
        session.value,
      );
      myMessage.value = "";
      contextBook.value = "";
      spoilerWarning.value = "";
      spoilerPage.value = "";
      spoilerProgressPercent.value = "";
      markAsSpoiler.value = false;
      if (route.name === "dm" && dmPeerActor.value) {
        await recordDmThread(dmPeerActor.value, text);
      }
    } catch (e) {
      sendError.value =
        e instanceof Error ? e.message : "Message could not be sent. Try again.";
    } finally {
      isSending.value = false;
    }
  }

  async function deleteMessage(message) {
    if (!session.value) return;
    deleteError.value = "";
    const pending = new Set(isDeleting.value);
    pending.add(message.url);
    isDeleting.value = pending;
    try {
      await graffiti.delete(message, session.value);
    } catch (e) {
      deleteError.value =
        e instanceof Error ? e.message : "Could not remove this message.";
    } finally {
      const done = new Set(isDeleting.value);
      done.delete(message.url);
      isDeleting.value = done;
    }
  }

  function dismissCreateError() {
    createClubError.value = "";
  }
  async function runOpenLibraryBookSearch() {
    const q = openLibrarySearchInput.value.trim();
    openLibrarySearchError.value = "";
    openLibraryHits.value = [];
    if (!q) {
      openLibrarySearchError.value = "Enter a title or author to search Open Library.";
      return;
    }
    openLibrarySearchAbort.value?.abort();
    const ctl = new AbortController();
    openLibrarySearchAbort.value = ctl;
    openLibrarySearching.value = true;
    try {
      openLibraryHits.value = await searchOpenLibraryBooks(q, ctl.signal);
      if (!openLibraryHits.value.length) {
        openLibrarySearchError.value = "No results from Open Library for that search.";
      }
    } catch (e) {
      if (e && typeof e === "object" && "name" in e && e.name === "AbortError") return;
      openLibrarySearchError.value =
        e instanceof Error ? e.message : "Could not reach Open Library. Check your connection.";
    } finally {
      openLibrarySearching.value = false;
    }
  }

  function applyOpenLibraryHit(hit) {
    if (!hit) return;
    newBookTitle.value = String(hit.title ?? "").trim();
    newBookIsbn.value = String(hit.isbn ?? "").trim();
    if (hit.totalPages != null && hit.totalPages > 0) {
      newBookTotalPages.value = String(hit.totalPages);
    }
    openLibraryHits.value = [];
    openLibrarySearchError.value = "";
  }

  function toggleAddBookForm() {
    showAddBookForm.value = !showAddBookForm.value;
    if (!showAddBookForm.value) {
      newBookTitle.value = "";
      newBookIsbn.value = "";
      newBookCurrentPage.value = "";
      newBookTotalPages.value = "";
      profileError.value = "";
      openLibrarySearchInput.value = "";
      openLibraryHits.value = [];
      openLibrarySearchError.value = "";
      openLibrarySearchAbort.value?.abort();
      openLibrarySearchAbort.value = null;
    }
  }
  function dismissSendError() {
    sendError.value = "";
  }
  function dismissDeleteError() {
    deleteError.value = "";
  }
  function dismissClubSettingsError() {
    clubSettingsError.value = "";
  }
  function goBackOr(fallbackRoute) {
    // `window.history.length` counts the whole tab (sites before this SPA), so `router.back()`
    // can leave GitHub Pages or drop the hash; the chat view vanishes with no in-app way back.
    // Vue Router records stack depth on `history.state.position`; only pop when that says we can.
    const pos =
      typeof window.history.state?.position === "number" ? window.history.state.position : null;
    if (pos != null && pos > 1) {
      router.back();
      return;
    }
    if (fallbackRoute) {
      void router.push(fallbackRoute);
    }
  }

  function channelInfoRoute(channelId, label, context = "") {
    return {
      name: "channel",
      query: {
        id: String(channelId ?? ""),
        label: String(label ?? "Channel"),
        context: String(context ?? ""),
      },
    };
  }

  async function copyChannelInfoId(channelId) {
    const raw = String(channelId ?? "").trim();
    if (!raw) return;
    channelInfoCopyFeedback.value = "";
    try {
      if (!navigator?.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable.");
      }
      await navigator.clipboard.writeText(raw);
      channelInfoCopyFeedback.value = "Channel id copied.";
    } catch {
      channelInfoCopyFeedback.value = "Could not copy channel id on this device.";
    }
  }

  function normalizeBookLookupKey(raw) {
    return String(raw ?? "")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ");
  }

  const myBookProgressByKey = computed(() => {
    const best = new Map();
    for (const entry of myCurrentlyReading.value) {
      const currentPage = Number.isFinite(entry.value?.currentPage) ? entry.value.currentPage : null;
      if (currentPage == null || currentPage < 0) continue;
      const totalPages = Number.isFinite(entry.value?.totalPages) ? entry.value.totalPages : null;
      const candidates = [entry.value?.title, entry.value?.isbn];
      for (const c of candidates) {
        const key = normalizeBookLookupKey(c);
        if (!key) continue;
        const prev = best.get(key);
        if (!prev || currentPage >= prev.currentPage) {
          best.set(key, { currentPage, totalPages });
        }
      }
    }
    return best;
  });

  function shouldAutoRevealSpoiler(msg) {
    if (!msg?.value?.isBlurred) return false;
    const spoilerPageThreshold = Number.isFinite(msg.value?.spoilerPage) ? msg.value.spoilerPage : null;
    const spoilerProgressThreshold = Number.isFinite(msg.value?.spoilerProgress) ? msg.value.spoilerProgress : null;
    if (spoilerPageThreshold == null && spoilerProgressThreshold == null) return false;
    const lookupKey = normalizeBookLookupKey(msg.value?.contextBook);
    if (!lookupKey) return false;
    const progress = myBookProgressByKey.value.get(lookupKey);
    if (!progress) return false;
    if (spoilerPageThreshold != null && progress.currentPage >= spoilerPageThreshold) return true;
    if (
      spoilerProgressThreshold != null &&
      Number.isFinite(progress.totalPages) &&
      progress.totalPages > 0 &&
      progress.currentPage / progress.totalPages >= spoilerProgressThreshold
    ) {
      return true;
    }
    return false;
  }

  return {
    BOOK_CLUB_DIRECTORY,
    profileChannel,
    session,
    activeChatChannel,
    activeClubChannel,
    clubChannelFromRoute,
    dmPeerActor,
    dmPeerInvalid,
    readerProfilePeerActor,
    readerProfileInvalid,
    readerProfileDiscoverChannel,
    readerProfilePollLoading,
    readerCurrentlyReading,
    readerBooksByStatus,
    dmSelfConversation,
    dmInboxRows,
    newDmPeerInput,
    openNewDm,
    peerToKey,
    dmChannelPreview,
    clubForActiveChat,
    threadHeadTitle,
    activeClubOwnerActor,
    userCanManageActiveClub,
    activeClubSettings,
    activeClubRequiresJoin,
    sortedClubs,
    filteredClubs,
    myClubsSearchQuery,
    myFilteredMemberClubs,
    isClubOwner,
    joinableDirectoryClubs,
    clubsLoading,
    clubSearchQuery,
    newClubName,
    isCreatingClub,
    createClubError,
    createBookClub,
    isUpdatingMembership,
    isMemberOfClub,
    joinClub,
    leaveActiveClub,
    clubSettingsName,
    clubSettingsNextMeetingAt,
    clubSettingsNextMeetingLocation,
    clubSettingsAllowedGenres,
    clubSettingsNextBook,
    showClubSettingsEditor,
    clubSettingsError,
    isSavingClubSettings,
    isDeletingClub,
    toggleClubSettingsEditor,
    saveActiveClubSettings,
    deleteActiveClub,
    latestOpenBookPoll,
    pollVotingOpen,
    activePollEndsAtMs,
    activePollAllMembersHaveVoted,
    activeClubPollMemberCount,
    activePollVoteTurnout,
    activePollOptions,
    activePollLeaders,
    activePollHasTie,
    myActivePollVoteOptionId,
    pollVoteSelection,
    activePollPreviewOption,
    activePollAwaitingOwnerFinalize,
    activePollWaitingForOwnerFinalize,
    showBookPollComposer,
    pollComposerError,
    isPostingBookPoll,
    pollDraftRows,
    pollOlQuery,
    pollOlHits,
    pollOlSearching,
    pollOlError,
    pollOlTargetRow,
    pollVoteError,
    isSubmittingPollVote,
    pollFinalizeError,
    isFinalizingPoll,
    tieBreakOptionId,
    addPollDraftRow,
    removePollDraftRow,
    runPollOpenLibrarySearch,
    applyPollOpenLibraryHit,
    enrichPollRowFromIsbn,
    submitCreateBookPoll,
    submitBookPollVote,
    finalizeBookPoll,
    pollVoteCountFor,
    getActivePollOptionTitle,
    sortedMessages,
    isMessageThreadLoading,
    messageViewportRef,
    myMessage,
    contextBook,
    markAsSpoiler,
    spoilerWarning,
    spoilerPage,
    spoilerProgressPercent,
    isSending,
    sendMessage,
    sendError,
    isDeleting,
    deleteMessage,
    deleteError,
    revealedMessageUrls,
    toggleReveal,
    toggleRevealWithAlert,
    dismissCreateError,
    dismissSendError,
    dismissDeleteError,
    dismissClubSettingsError,
    goBackOr,
    channelInfoRoute,
    copyChannelInfoId,
    channelInfoCopyFeedback,
    shouldAutoRevealSpoiler,
    profilePollLoading,
    myCurrentlyReading,
    myBooksByStatus,
    newBookTitle,
    newBookIsbn,
    newBookCurrentPage,
    newBookTotalPages,
    openLibrarySearchInput,
    openLibraryHits,
    openLibrarySearching,
    openLibrarySearchError,
    runOpenLibraryBookSearch,
    applyOpenLibraryHit,
    showAddBookForm,
    isAddingBook,
    profileError,
    isRemovingBook,
    isUpdatingBook,
    bookPageDrafts,
    normalizeBookStatus,
    splitBooksByStatus,
    ensureBookPageDraft,
    setBookPageDraft,
    toggleAddBookForm,
    addCurrentlyReadingBook,
    removeCurrentlyReadingBook,
    updateCurrentPage,
    markBookFinished,
    markBookDnf,
    markBookReading,
    dismissProfileError,
  };
}
