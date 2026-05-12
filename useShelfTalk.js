import { ref, computed, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGraffiti, useGraffitiSession, useGraffitiDiscover } from "@graffiti-garden/wrapper-vue";
import { directMessageChannelId, peerToKey, keyToPeer } from "./directMessage.js";
import { searchOpenLibraryBooks } from "./booksApi.js";

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

const noteMessageSchema = {
  properties: {
    value: {
      required: ["type", "content", "published"],
      properties: {
        type: { const: "Note" },
        content: { type: "string" },
        published: { type: "number" },
        contextBook: { type: "string" },
        isBlurred: { type: "boolean" },
        spoilerWarning: { type: "string" },
        spoilerPage: { type: "number" },
        spoilerProgress: { type: "number" },
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

  /** Book-club message channel only while on the chat thread (not the settings page). */
  const activeClubChannel = computed(() => {
    if (route.name === "chat" && route.params.chatId) {
      return String(route.params.chatId);
    }
    return null;
  });

  /** Club id from URL on chat or club-settings routes (membership, metadata, settings UI). */
  const clubChannelFromRoute = computed(() => {
    if (
      (route.name === "chat" || route.name === "chat-settings") &&
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
    if (!channelId) return false;
    const club = sortedClubs.value.find((c) => c.value?.channel === channelId);
    if (club && session.value?.actor && club.value?.ownerActor === session.value.actor) {
      return true;
    }
    return myClubMembershipByChannel.value.get(channelId) === true;
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

  const activeClubSettings = computed(() => {
    const value = clubForActiveChat.value?.value;
    if (!value) return null;
    return {
      name: value.name ?? "",
      nextMeetingAt: value.nextMeetingAt ?? "",
      nextMeetingLocation: value.nextMeetingLocation ?? "",
      allowedGenres: value.allowedGenres ?? "",
      nextBook: value.nextBook ?? "",
    };
  });

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

  const { objects: rawMessages, isFirstPoll: messagesLoading } = useGraffitiDiscover(
    () => [selectedMessageChannel.value],
    noteMessageSchema,
    undefined,
    true,
  );

  const sortedMessages = computed(() => {
    const list = rawMessages.value.filter(
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
          channels: [profileChannel.value],
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
    () => clubForActiveChat.value?.url,
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
          channels: [profileChannel.value],
        },
        session.value,
      );
      const onThisClub =
        (route.name === "chat" || route.name === "chat-settings") &&
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
          channels: [profileChannel.value],
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
      const book = contextBook.value.trim();
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
