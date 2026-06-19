import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  SimplePool,
  finalizeEvent,
  nip19,
  nip57,
  type EventTemplate,
  type Event,
  type Filter,
} from "nostr-tools";
import "./App.css";

const pool = new SimplePool();

const RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://purplepag.es",
  "wss://offchain.pub",
];
const PRESET_AMOUNTS = [1000, 10000];
const DEFAULT_TIP_NOTE = "Sent via tipstr.app";
const PRIMARY_PROFILE_RELAYS = RELAYS.slice(0, 2);
const FALLBACK_PROFILE_RELAYS = RELAYS.slice(2);
const PROFILE_FALLBACK_DELAY_MS = 3000;
const TIPSTR_NAME_KIND = 30078;
const TIPSTR_NAME_D_TAG = "tipstr-profile";
const TIPSTR_NAME_D_TAG_PREFIX = "tipstr-name:";
const TIPSTR_NAME_QUERY_WAIT_MS = 5000;
const TIPSTR_NAME_PUBLISH_WAIT_MS = 6000;

type Profile = {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  banner?: string;
  website?: string;
  nip05?: string;
  lud06?: string;
  lud16?: string;
};

type ProfileState = {
  pubkey: string;
  npub: string;
  profile: Profile;
};

type LnurlPayDetails = {
  callback: string;
  minSendable: number;
  maxSendable: number;
  metadata: string;
  commentAllowed?: number;
  domain: string;
};

type InvoiceState = {
  pr: string;
  verify?: string;
  successAction?: unknown;
};

type Nip05Status = "idle" | "checking" | "verified" | "invalid";
type PaymentStatus = "idle" | "awaiting" | "paid" | "unsupported";

type SignedInUser = {
  pubkey: string;
  npub: string;
};

type TipstrNameClaim = {
  event: Event;
  name: string;
};

type TipstrNameOwner = {
  pubkey: string;
  npub: string;
  name: string;
  event: Event;
};

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (event: EventTemplate) => Promise<Event>;
    };
  }
}

const PAYMENT_POLL_INTERVAL_MS = 3000;
const PAYMENT_POLL_TIMEOUT_MS = 120000;
const builderCredit = (
  <p className="builder-credit">
    Built by{" "}
    <a href="https://primal.net/edward" target="_blank" rel="noreferrer">
      <b>Edward</b>
    </a>
  </p>
);

function parseProfile(rawContent: string) {
  try {
    return JSON.parse(rawContent) as Profile;
  } catch {
    return null;
  }
}

function formatIdentity(profile: Profile | null, npub: string) {
  if (!profile) {
    return npub.slice(0, 14);
  }

  return profile.display_name || profile.name || npub.slice(0, 14);
}

function formatHandle(profile: Profile | null, npub: string) {
  if (profile?.name) {
    return `@${profile.name}`;
  }

  return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
}

function normalizeWebsiteUrl(website?: string) {
  if (!website?.trim()) {
    return null;
  }

  const trimmed = website.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(withProtocol);
  } catch {
    return null;
  }
}

function decodeNpub(npub: string) {
  const decoded = nip19.decode(npub.trim());

  if (decoded.type !== "npub") {
    throw new Error("That value is not a valid npub.");
  }

  return decoded.data;
}

function encodeNpub(pubkey: string) {
  return nip19.npubEncode(pubkey);
}

function isValidNpub(value: string) {
  try {
    decodeNpub(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTipstrName(value: string) {
  return value.trim().toLowerCase();
}

function validateTipstrName(value: string) {
  const name = normalizeTipstrName(value);

  if (!name) {
    return "Enter a Tipstr name.";
  }

  if (name.length < 3 || name.length > 20) {
    return "Tipstr names must be 3 to 20 characters.";
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return "Use only lowercase letters, numbers, and hyphens.";
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    return "Tipstr names cannot start or end with a hyphen.";
  }

  if (name.startsWith("npub")) {
    return "Tipstr names cannot start with npub.";
  }

  return "";
}

function getTag(event: Event, tagName: string) {
  return event.tags.find((tag) => tag[0] === tagName)?.[1] ?? null;
}

function buildTipstrNameDTag(name: string) {
  return `${TIPSTR_NAME_D_TAG_PREFIX}${normalizeTipstrName(name)}`;
}

function parseTipstrNameClaim(event: Event) {
  if (event.kind !== TIPSTR_NAME_KIND) {
    return null;
  }

  const dTag = getTag(event, "d");

  if (
    dTag !== TIPSTR_NAME_D_TAG &&
    !dTag?.startsWith(TIPSTR_NAME_D_TAG_PREFIX)
  ) {
    return null;
  }

  const tagName = getTag(event, "name");
  const dTagName = dTag?.startsWith(TIPSTR_NAME_D_TAG_PREFIX)
    ? normalizeTipstrName(dTag.slice(TIPSTR_NAME_D_TAG_PREFIX.length))
    : null;
  let contentName: string | null = null;

  try {
    const content = JSON.parse(event.content) as { name?: unknown };
    if (typeof content.name === "string") {
      contentName = normalizeTipstrName(content.name);
    }
  } catch {
    contentName = null;
  }

  const normalizedTagName = tagName ? normalizeTipstrName(tagName) : null;
  const name = dTagName || contentName || normalizedTagName;

  if (!name || validateTipstrName(name)) {
    return null;
  }

  if (dTagName && contentName && dTagName !== contentName) {
    return null;
  }

  if (dTagName && normalizedTagName && dTagName !== normalizedTagName) {
    return null;
  }

  if (contentName && normalizedTagName && contentName !== normalizedTagName) {
    return null;
  }

  return { event, name } satisfies TipstrNameClaim;
}

function compareEventsNewestFirst(left: Event, right: Event) {
  if (left.created_at !== right.created_at) {
    return right.created_at - left.created_at;
  }

  return right.id.localeCompare(left.id);
}

function compareEventsOldestFirst(left: Event, right: Event) {
  if (left.created_at !== right.created_at) {
    return left.created_at - right.created_at;
  }

  return left.id.localeCompare(right.id);
}

function getMatchingTipstrNameClaimPubkeys(events: Event[], name: string) {
  const normalizedName = normalizeTipstrName(name);

  return Array.from(
    new Set(
      events
        .map(parseTipstrNameClaim)
        .filter((claim): claim is TipstrNameClaim => Boolean(claim))
        .filter((claim) => claim.name === normalizedName)
        .map((claim) => claim.event.pubkey),
    ),
  );
}

function pickValidTipstrNameOwner(
  claimEvents: Event[],
  pointerEvents: Event[],
  name: string,
) {
  const normalizedName = normalizeTipstrName(name);
  const latestPointerByPubkey = new Map<string, TipstrNameClaim>();

  for (const event of pointerEvents) {
    const claim = parseTipstrNameClaim(event);

    if (!claim || getTag(event, "d") !== TIPSTR_NAME_D_TAG) {
      continue;
    }

    const current = latestPointerByPubkey.get(event.pubkey);

    if (
      !current ||
      event.created_at > current.event.created_at ||
      (event.created_at === current.event.created_at &&
        event.id > current.event.id)
    ) {
      latestPointerByPubkey.set(event.pubkey, claim);
    }
  }

  const matchingClaims = claimEvents
    .map(parseTipstrNameClaim)
    .filter((claim): claim is TipstrNameClaim => Boolean(claim))
    .filter((claim) => claim.name === normalizedName)
    .filter(
      (claim) =>
        latestPointerByPubkey.get(claim.event.pubkey)?.name === normalizedName,
    )
    .sort((left, right) => compareEventsOldestFirst(left.event, right.event));

  const owner = matchingClaims[0]?.event;

  if (!owner) {
    return null;
  }

  return {
    pubkey: owner.pubkey,
    npub: encodeNpub(owner.pubkey),
    name: normalizedName,
    event: owner,
  } satisfies TipstrNameOwner;
}

async function queryTipstrNameEvents(filter: Filter) {
  return pool.querySync(RELAYS, filter, {
    maxWait: TIPSTR_NAME_QUERY_WAIT_MS,
  });
}

async function resolveTipstrName(name: string) {
  const normalizedName = normalizeTipstrName(name);
  const directClaimEvents = await queryTipstrNameEvents({
    kinds: [TIPSTR_NAME_KIND],
    "#d": [buildTipstrNameDTag(normalizedName)],
  });
  const claimPubkeys = getMatchingTipstrNameClaimPubkeys(
    directClaimEvents,
    normalizedName,
  );

  if (claimPubkeys.length) {
    const pointerEvents = await queryTipstrNameEvents({
      kinds: [TIPSTR_NAME_KIND],
      authors: claimPubkeys,
      "#d": [TIPSTR_NAME_D_TAG],
    });
    const directOwner = pickValidTipstrNameOwner(
      directClaimEvents,
      pointerEvents,
      normalizedName,
    );

    if (directOwner) {
      return directOwner;
    }
  }

  const broadEvents = await queryTipstrNameEvents({
    kinds: [TIPSTR_NAME_KIND],
  });
  const legacyClaimPubkeys = getMatchingTipstrNameClaimPubkeys(
    broadEvents,
    normalizedName,
  );

  if (!legacyClaimPubkeys.length) {
    return null;
  }

  const pointerEvents = await queryTipstrNameEvents({
    kinds: [TIPSTR_NAME_KIND],
    authors: legacyClaimPubkeys,
    "#d": [TIPSTR_NAME_D_TAG],
  });

  return pickValidTipstrNameOwner(broadEvents, pointerEvents, normalizedName);
}

async function fetchUserTipstrName(pubkey: string) {
  const events = await queryTipstrNameEvents({
    kinds: [TIPSTR_NAME_KIND],
    authors: [pubkey],
    "#d": [TIPSTR_NAME_D_TAG],
  });

  const latest = events
    .map(parseTipstrNameClaim)
    .filter((claim): claim is TipstrNameClaim => Boolean(claim))
    .sort((left, right) => compareEventsNewestFirst(left.event, right.event))[0];

  return latest?.name ?? "";
}

async function signInWithNostr() {
  if (!window.nostr) {
    throw new Error("Install or unlock a NIP-07 Nostr signer to sign in.");
  }

  const pubkey = await window.nostr.getPublicKey();

  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    throw new Error("Your Nostr signer returned an invalid public key.");
  }

  return {
    pubkey: pubkey.toLowerCase(),
    npub: encodeNpub(pubkey),
  } satisfies SignedInUser;
}

async function saveTipstrName(name: string, signedInUser: SignedInUser) {
  if (!window.nostr) {
    throw new Error("Install or unlock a NIP-07 Nostr signer to save a name.");
  }

  const normalizedName = normalizeTipstrName(name);
  const validationError = validateTipstrName(normalizedName);

  if (validationError) {
    throw new Error(validationError);
  }

  const owner = await resolveTipstrName(normalizedName);

  if (owner && owner.pubkey !== signedInUser.pubkey) {
    throw new Error("That Tipstr name is already owned by another npub.");
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const unsignedClaimEvent: EventTemplate = {
    kind: TIPSTR_NAME_KIND,
    created_at: createdAt,
    content: JSON.stringify({ name: normalizedName }),
    tags: [
      ["d", buildTipstrNameDTag(normalizedName)],
      ["name", normalizedName],
    ],
  };
  const unsignedPointerEvent: EventTemplate = {
    kind: TIPSTR_NAME_KIND,
    created_at: createdAt + 1,
    content: JSON.stringify({ name: normalizedName }),
    tags: [
      ["d", TIPSTR_NAME_D_TAG],
      ["name", normalizedName],
    ],
  };

  const signedClaimEvent = await window.nostr.signEvent(unsignedClaimEvent);
  const signedPointerEvent = await window.nostr.signEvent(unsignedPointerEvent);

  if (
    signedClaimEvent.pubkey.toLowerCase() !== signedInUser.pubkey ||
    signedPointerEvent.pubkey.toLowerCase() !== signedInUser.pubkey
  ) {
    throw new Error("Your signer used a different Nostr account.");
  }

  await Promise.allSettled(
    [signedClaimEvent, signedPointerEvent].flatMap((event) =>
      pool.publish(RELAYS, event, {
        maxWait: TIPSTR_NAME_PUBLISH_WAIT_MS,
      }),
    ),
  );

  const confirmedOwner = await resolveTipstrName(normalizedName);

  if (!confirmedOwner || confirmedOwner.pubkey !== signedInUser.pubkey) {
    throw new Error(
      "The name was signed, but relays did not confirm ownership yet. Try again in a moment.",
    );
  }

  return normalizedName;
}

function decodeLud06(lud06: string) {
  const normalized = lud06.trim();

  if (!normalized.toLowerCase().startsWith("lnurl")) {
    throw new Error("Lightning data is present but not a valid lud06 LNURL.");
  }

  return normalized;
}

function buildLnurlUrl(profile: Profile) {
  if (profile.lud16) {
    const [name, domain] = profile.lud16.split("@");

    if (!name || !domain) {
      throw new Error("Lightning address is malformed.");
    }

    return `https://${domain}/.well-known/lnurlp/${name}`;
  }

  if (profile.lud06) {
    return decodeLud06(profile.lud06);
  }

  throw new Error("This profile does not have a Lightning address.");
}

function parseLnurlPayUrl(rawUrl: string) {
  const parsed = new URL(rawUrl);
  return { href: parsed.toString(), domain: parsed.hostname };
}

function parseRoute(pathname: string) {
  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (!segments.length) {
    return { npub: null, amount: null };
  }

  const [npubSegment, amountSegment] = segments;

  if (!npubSegment) {
    return { npub: null, amount: null };
  }

  if (!amountSegment) {
    return { npub: npubSegment, amount: null };
  }

  if (!/^\d+$/.test(amountSegment)) {
    return { npub: npubSegment, amount: null };
  }

  const parsedAmount = Number(amountSegment);

  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return { npub: npubSegment, amount: null };
  }

  return { npub: npubSegment, amount: parsedAmount };
}

function isLikelyTipstrName(value: string) {
  return !validateTipstrName(value);
}

function buildProfilePath(npub: string) {
  return `/${npub.trim()}`;
}

function buildTipstrNamePath(name: string) {
  return `/${normalizeTipstrName(name)}`;
}

function buildAmountPath(npub: string, amount: number) {
  return `/${npub.trim()}/${amount}`;
}

async function fetchProfile(npub: string): Promise<ProfileState> {
  const pubkey = decodeNpub(npub);
  const filter = { kinds: [0], authors: [pubkey] };

  return new Promise<ProfileState>((resolve, reject) => {
    const activeSubscriptions = new Set<{ close?: () => void }>();
    const closedRelays = new Set<string>();
    let fallbackTimer: number | null = null;
    let settled = false;

    const finish = (handler: () => void) => {
      if (settled) {
        return;
      }

      settled = true;

      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
      }

      for (const subscription of activeSubscriptions) {
        subscription.close?.();
      }

      activeSubscriptions.clear();
      handler();
    };

    const maybeReject = () => {
      if (settled) {
        return;
      }

      if (closedRelays.size !== RELAYS.length) {
        return;
      }

      finish(() => {
        reject(
          new Error(
            "Unable to load profile metadata from available relays. Please try again in a moment.",
          ),
        );
      });
    };

    const handleEvent = (event: Event) => {
      const profile = parseProfile(event.content);

      if (!profile) {
        return;
      }

      finish(() => {
        resolve({ pubkey, npub, profile });
      });
    };

    const subscribeToRelays = (relays: string[]) => {
      for (const relay of relays) {
        const subscription = pool.subscribeMany([relay], filter, {
          onevent: handleEvent,
          oneose: () => {
            closedRelays.add(relay);
            activeSubscriptions.delete(subscription);
            maybeReject();
          },
          onclose: () => {
            closedRelays.add(relay);
            activeSubscriptions.delete(subscription);
            maybeReject();
          },
        });

        activeSubscriptions.add(subscription);
      }
    };

    subscribeToRelays(PRIMARY_PROFILE_RELAYS);

    fallbackTimer = window.setTimeout(() => {
      if (settled) {
        return;
      }

      subscribeToRelays(FALLBACK_PROFILE_RELAYS);
    }, PROFILE_FALLBACK_DELAY_MS);
  });
}

async function verifyNip05(nip05: string, pubkey: string) {
  const trimmed = nip05.trim();

  if (!trimmed || !trimmed.includes("@")) {
    return false;
  }

  const [name, domain] = trimmed.split("@");

  if (!name || !domain) {
    return false;
  }

  const url = new URL(`https://${domain}/.well-known/nostr.json`);
  url.searchParams.set("name", name);

  const response = await fetch(url.toString());

  if (!response.ok) {
    return false;
  }

  const data = (await response.json()) as {
    names?: Record<string, string>;
  };

  return data.names?.[name]?.toLowerCase() === pubkey.toLowerCase();
}

async function fetchLnurlPay(profile: Profile) {
  const { href, domain } = parseLnurlPayUrl(buildLnurlUrl(profile));
  const response = await fetch(href);

  if (!response.ok) {
    throw new Error("Unable to fetch Lightning pay details.");
  }

  const data = (await response.json()) as Partial<LnurlPayDetails> & {
    status?: string;
    reason?: string;
    tag?: string;
  };

  if (data.status === "ERROR") {
    throw new Error(data.reason || "Lightning server returned an error.");
  }

  if (
    data.tag !== "payRequest" ||
    typeof data.callback !== "string" ||
    !data.callback.trim() ||
    typeof data.minSendable !== "number" ||
    !Number.isFinite(data.minSendable) ||
    typeof data.maxSendable !== "number" ||
    !Number.isFinite(data.maxSendable) ||
    data.maxSendable < data.minSendable ||
    typeof data.metadata !== "string" ||
    !data.metadata.trim()
  ) {
    throw new Error("Lightning pay details are incomplete.");
  }

  return {
    callback: data.callback,
    minSendable: data.minSendable,
    maxSendable: data.maxSendable,
    metadata: data.metadata,
    commentAllowed: data.commentAllowed,
    domain,
  } satisfies LnurlPayDetails;
}

async function generateZapRequest(
  pubkey: string,
  amountMsats: number,
  note: string,
) {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const eventTemplate: EventTemplate = {
    kind: 9734,
    created_at: Math.floor(Date.now() / 1000),
    content: note,
    tags: [
      ["p", pubkey],
      ["amount", String(amountMsats)],
      ["relays", ...RELAYS],
    ],
  };

  return JSON.stringify(finalizeEvent(eventTemplate, privateKey));
}

async function fetchInvoice(
  details: LnurlPayDetails,
  amountSats: number,
  note: string,
  pubkey: string,
) {
  const amountMsats = amountSats * 1000;

  if (amountMsats < details.minSendable || amountMsats > details.maxSendable) {
    throw new Error(
      `Enter an amount between ${Math.ceil(details.minSendable / 1000)} and ${Math.floor(details.maxSendable / 1000)} sats.`,
    );
  }

  const url = new URL(details.callback);
  url.searchParams.set("amount", String(amountMsats));

  if (
    note.trim() &&
    details.commentAllowed &&
    note.length <= details.commentAllowed
  ) {
    url.searchParams.set("comment", note.trim());
  }

  try {
    const unsignedZapRequest = nip57.makeZapRequest({
      pubkey,
      amount: amountMsats,
      comment: note.trim(),
      relays: RELAYS,
    });
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    const encodedZapRequest = JSON.stringify(
      finalizeEvent(unsignedZapRequest, privateKey),
    );

    url.searchParams.set("nostr", encodedZapRequest);
  } catch {
    const zapRequest = await generateZapRequest(
      pubkey,
      amountMsats,
      note.trim(),
    );
    url.searchParams.set("nostr", zapRequest);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error("Unable to create a Lightning invoice.");
  }

  const data = (await response.json()) as InvoiceState & {
    status?: string;
    reason?: string;
  };

  if (data.status === "ERROR") {
    throw new Error(
      data.reason || "Lightning server returned an invoice error.",
    );
  }

  if (!data.pr) {
    throw new Error("Lightning server did not return a payment request.");
  }

  return data;
}

async function checkInvoicePaid(verifyUrl: string) {
  const response = await fetch(verifyUrl);

  if (!response.ok) {
    throw new Error("Unable to verify invoice payment status.");
  }

  const data = (await response.json()) as {
    status?: string;
    settled?: boolean;
    paid?: boolean;
    preimage?: string;
    pr?: string;
    result?: string;
  };

  if (data.status === "ERROR") {
    return false;
  }

  if (
    data.settled === true ||
    data.paid === true ||
    typeof data.preimage === "string"
  ) {
    return true;
  }

  return data.result === "paid";
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back for browsers like mobile Safari.
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}

function resetCopiedState(
  setter: React.Dispatch<React.SetStateAction<boolean>>,
) {
  setter(true);
  window.setTimeout(() => {
    setter(false);
  }, 3000);
}

function App() {
  const invoiceSectionRef = useRef<HTMLElement | null>(null);
  const lastAutoGeneratedRouteRef = useRef<string | null>(null);
  const hasEditedTipstrNameRef = useRef(false);
  const bioRef = useRef<HTMLParagraphElement | null>(null);
  const hasInitialRoute = Boolean(
    parseRoute(window.location.pathname).npub ||
      new URLSearchParams(window.location.search).get("npub")?.trim(),
  );
  const [inputValue, setInputValue] = useState("");
  const [activeNpub, setActiveNpub] = useState<string | null>(null);
  const [activeTipstrName, setActiveTipstrName] = useState<string | null>(null);
  const [routeAmount, setRouteAmount] = useState<number | null>(null);
  const [routeError, setRouteError] = useState("");
  const [profileState, setProfileState] = useState<ProfileState | null>(null);
  const [lnurlPay, setLnurlPay] = useState<LnurlPayDetails | null>(null);
  const [invoice, setInvoice] = useState<InvoiceState | null>(null);
  const [selectedAmount, setSelectedAmount] = useState(1000);
  const [customAmountInput, setCustomAmountInput] = useState("1000");
  const [note, setNote] = useState(DEFAULT_TIP_NOTE);
  const [profileError, setProfileError] = useState("");
  const [invoiceError, setInvoiceError] = useState("");
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [isLoadingInvoice, setIsLoadingInvoice] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedNpub, setCopiedNpub] = useState(false);
  const [copiedLightning, setCopiedLightning] = useState(false);
  const [showNoteField, setShowNoteField] = useState(false);
  const [nip05Status, setNip05Status] = useState<Nip05Status>("idle");
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>("idle");
  const [isBioExpanded, setIsBioExpanded] = useState(false);
  const [isBioTruncated, setIsBioTruncated] = useState(false);
  const [signedInUser, setSignedInUser] = useState<SignedInUser | null>(null);
  const [tipstrNameInput, setTipstrNameInput] = useState("");
  const [savedTipstrName, setSavedTipstrName] = useState("");
  const [authError, setAuthError] = useState("");
  const [authStatus, setAuthStatus] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSavingTipstrName, setIsSavingTipstrName] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isResolvingInitialRoute, setIsResolvingInitialRoute] =
    useState(hasInitialRoute);

  useEffect(() => {
    let cancelled = false;

    function finishInitialRoute() {
      if (!cancelled) {
        setIsResolvingInitialRoute(false);
      }
    }

    function clearActiveRoute(
      error = "",
      nextInputValue = "",
    ) {
      window.history.replaceState({}, "", "/");
      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setInputValue(nextInputValue);
      setRouteError(error);
    }

    async function resolveInitialRoute() {
      const { npub: pathNpub, amount: pathAmount } = parseRoute(
        window.location.pathname,
      );
      const queryNpub =
        new URLSearchParams(window.location.search).get("npub")?.trim() || null;

      if (pathNpub) {
        if (isValidNpub(pathNpub)) {
          if (cancelled) {
            return;
          }

          setActiveNpub(pathNpub);
          setActiveTipstrName(null);
          setRouteAmount(pathAmount);
          setInputValue(pathNpub);
          setRouteError("");
          finishInitialRoute();
          return;
        }

        if (!isLikelyTipstrName(pathNpub)) {
          if (!cancelled) {
            clearActiveRoute(
              "That URL does not contain a valid npub or Tipstr name.",
            );
            finishInitialRoute();
          }
          return;
        }

        try {
          const owner = await resolveTipstrName(pathNpub);

          if (cancelled) {
            return;
          }

          if (!owner) {
            clearActiveRoute("That Tipstr name is not claimed.");
            finishInitialRoute();
            return;
          }

          setActiveNpub(owner.npub);
          setActiveTipstrName(owner.name);
          setRouteAmount(pathAmount);
          setInputValue(owner.name);
          setRouteError("");
          finishInitialRoute();
        } catch {
          if (!cancelled) {
            clearActiveRoute("Unable to resolve that Tipstr name from relays.");
            finishInitialRoute();
          }
        }

        return;
      }

      if (queryNpub && isValidNpub(queryNpub)) {
        const nextPath = buildProfilePath(queryNpub);
        window.history.replaceState({}, "", nextPath);
        if (cancelled) {
          return;
        }

        setActiveNpub(queryNpub);
        setActiveTipstrName(null);
        setRouteAmount(null);
        setInputValue(queryNpub);
        setRouteError("");
        finishInitialRoute();
        return;
      }

      if (cancelled) {
        return;
      }

      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setInputValue("");
      setRouteError("");
      finishInitialRoute();
    }

    void resolveInitialRoute();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (routeAmount && activeNpub) {
      setSelectedAmount(routeAmount);
      setCustomAmountInput(String(routeAmount));
      return;
    }

    if (!activeNpub) {
      setSelectedAmount(1000);
      setCustomAmountInput("1000");
    }
  }, [activeNpub, routeAmount]);

  useEffect(() => {
    if (!signedInUser) {
      hasEditedTipstrNameRef.current = false;
      setTipstrNameInput("");
      setSavedTipstrName("");
      return;
    }

    let cancelled = false;
    const pubkey = signedInUser.pubkey;
    hasEditedTipstrNameRef.current = false;

    async function loadUserTipstrName() {
      try {
        const name = await fetchUserTipstrName(pubkey);

        if (cancelled) {
          return;
        }

        setSavedTipstrName(name);
        if (!hasEditedTipstrNameRef.current) {
          setTipstrNameInput(name);
        }
      } catch {
        if (!cancelled) {
          setAuthError("Unable to load your saved Tipstr name from relays.");
        }
      }
    }

    void loadUserTipstrName();

    return () => {
      cancelled = true;
    };
  }, [signedInUser]);

  useEffect(() => {
    if (!authStatus || authStatus === "Cross-checking relays for name ownership...") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setAuthStatus((currentStatus) =>
        currentStatus === authStatus ? "" : currentStatus,
      );
    }, 3000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [authStatus]);

  useEffect(() => {
    document.body.classList.toggle("home-page", !activeNpub);

    return () => {
      document.body.classList.remove("home-page");
    };
  }, [activeNpub]);

  useEffect(() => {
    if (!activeNpub) {
      lastAutoGeneratedRouteRef.current = null;
      setProfileState(null);
      setLnurlPay(null);
      setInvoice(null);
      setProfileError("");
      setNip05Status("idle");
      setPaymentStatus("idle");
      setShowNoteField(false);
      setIsBioExpanded(false);
      setIsBioTruncated(false);
      setCopiedLightning(false);
      setNote(DEFAULT_TIP_NOTE);
      setSelectedAmount(routeAmount ?? 1000);
      setCustomAmountInput(String(routeAmount ?? 1000));
      return;
    }

    const npub = activeNpub;

    let cancelled = false;

    async function load() {
      setIsLoadingProfile(true);
      setProfileError("");
      setInvoiceError("");
      setInvoice(null);
      setLnurlPay(null);
      setNip05Status("idle");
      setPaymentStatus("idle");
      setShowNoteField(false);
      setIsBioExpanded(false);
      setIsBioTruncated(false);
      setCopiedNpub(false);
      setCopiedLightning(false);
      setNote(DEFAULT_TIP_NOTE);
      setSelectedAmount(routeAmount ?? 1000);
      setCustomAmountInput(String(routeAmount ?? 1000));

      try {
        const loadedProfile = await fetchProfile(npub);
        const lnurlDetails = await fetchLnurlPay(loadedProfile.profile);

        if (cancelled) {
          return;
        }

        setProfileState(loadedProfile);
        setLnurlPay(lnurlDetails);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error
            ? error.message
            : "Unable to load this profile.";
        setProfileState(null);
        setProfileError(message);
      } finally {
        if (!cancelled) {
          setIsLoadingProfile(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [activeNpub, routeAmount]);

  useEffect(() => {
    if (
      !activeNpub ||
      !profileState ||
      profileState.npub !== activeNpub ||
      !lnurlPay ||
      !routeAmount ||
      invoice?.pr
    ) {
      return;
    }

    const routeKey = `${activeNpub}:${routeAmount}`;
    const currentLnurlPay = lnurlPay;
    const currentNpub = activeNpub;
    const currentPubkey = profileState.pubkey;
    const currentRouteAmount = routeAmount;

    if (lastAutoGeneratedRouteRef.current === routeKey) {
      return;
    }

    lastAutoGeneratedRouteRef.current = routeKey;

    async function generateRouteInvoice() {
      setIsLoadingInvoice(true);
      setInvoiceError("");
      setCopied(false);
      setCopiedLightning(false);
      setPaymentStatus("idle");

      try {
        const nextInvoice = await fetchInvoice(
          currentLnurlPay,
          currentRouteAmount,
          DEFAULT_TIP_NOTE,
          currentPubkey,
        );
        if (activeNpub !== currentNpub) {
          return;
        }
        setInvoice(nextInvoice);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to generate an invoice.";
        setInvoice(null);
        setInvoiceError(message);
      } finally {
        setIsLoadingInvoice(false);
      }
    }

    void generateRouteInvoice();
  }, [activeNpub, invoice?.pr, lnurlPay, profileState, routeAmount]);

  useEffect(() => {
    const bioElement = bioRef.current;
    const about = profileState?.profile.about;

    if (!bioElement || !about) {
      setIsBioTruncated(false);
      return;
    }

    if (isBioExpanded) {
      return;
    }

    const measureBio = () => {
      const isTruncated = bioElement.scrollHeight - bioElement.clientHeight > 1;
      setIsBioTruncated(isTruncated);
    };

    measureBio();
    window.addEventListener("resize", measureBio);

    return () => {
      window.removeEventListener("resize", measureBio);
    };
  }, [isBioExpanded, profileState?.profile.about]);

  useEffect(() => {
    const currentNip05 = profileState?.profile.nip05;
    const currentPubkey = profileState?.pubkey;

    if (!currentNip05 || !currentPubkey) {
      setNip05Status("idle");
      return;
    }

    const nip05 = currentNip05;
    const pubkey = currentPubkey;
    let cancelled = false;

    async function runVerification() {
      setNip05Status("checking");

      try {
        const isVerified = await verifyNip05(nip05, pubkey);

        if (!cancelled) {
          setNip05Status(isVerified ? "verified" : "invalid");
        }
      } catch {
        if (!cancelled) {
          setNip05Status("invalid");
        }
      }
    }

    void runVerification();

    return () => {
      cancelled = true;
    };
  }, [profileState]);

  useEffect(() => {
    if (!invoice?.pr) {
      return;
    }

    invoiceSectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [invoice?.pr]);

  useEffect(() => {
    const currentVerifyUrl = invoice?.verify;

    if (!invoice?.pr) {
      setPaymentStatus("idle");
      return;
    }

    if (!currentVerifyUrl) {
      setPaymentStatus("unsupported");
      return;
    }

    const verifyUrl = currentVerifyUrl;

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void pollPayment();
    }, PAYMENT_POLL_INTERVAL_MS);

    const timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        setPaymentStatus("unsupported");
      }

      window.clearInterval(intervalId);
    }, PAYMENT_POLL_TIMEOUT_MS);

    async function pollPayment() {
      try {
        const isPaid = await checkInvoicePaid(verifyUrl);

        if (cancelled) {
          return;
        }

        if (isPaid) {
          setPaymentStatus("paid");

          window.clearInterval(intervalId);
          window.clearTimeout(timeoutId);
        }
      } catch {
        if (!cancelled) {
          setPaymentStatus("unsupported");

            window.clearInterval(intervalId);
            window.clearTimeout(timeoutId);
        }
      }
    }

    setPaymentStatus("awaiting");
    void pollPayment();

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [invoice]);

  const amountRange = useMemo(() => {
    if (!lnurlPay) {
      return null;
    }

    return {
      min: Math.ceil(lnurlPay.minSendable / 1000),
      max: Math.floor(lnurlPay.maxSendable / 1000),
    };
  }, [lnurlPay]);

  const title = formatIdentity(profileState?.profile ?? null, activeNpub ?? "");
  const handle = formatHandle(profileState?.profile ?? null, activeNpub ?? "");
  const npubLabel = activeNpub
    ? `${activeNpub.slice(0, 18)}...${activeNpub.slice(-8)}`
    : "Resolving profile...";
  const websiteUrl = normalizeWebsiteUrl(profileState?.profile.website);
  const websiteLabel = websiteUrl?.hostname.replace(/^www\./, "") ?? null;
  const lightningAddress = profileState?.profile.lud16 ?? null;
  const lightningLabel =
    profileState?.profile.lud16 ??
    (profileState?.profile.lud06 ? "LNURL enabled" : null);
  const nip05Label =
    nip05Status === "verified"
      ? "Verified"
      : nip05Status === "invalid"
        ? "Unverified"
        : "Checking";

  const activePathName = activeTipstrName || activeNpub || "";

  async function navigateToProfile(value: string) {
    const routeValue = value.trim();

    if (!routeValue) {
      window.history.pushState({}, "", "/");
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setRouteError("Enter a valid npub or Tipstr name.");
      setInputValue("");
      return;
    }

    if (isValidNpub(routeValue)) {
      window.history.pushState({}, "", buildProfilePath(routeValue));
      lastAutoGeneratedRouteRef.current = null;
      setRouteError("");
      setRouteAmount(null);
      setActiveNpub(routeValue);
      setActiveTipstrName(null);
      setInputValue(routeValue);
      return;
    }

    if (!isLikelyTipstrName(routeValue)) {
      window.history.pushState({}, "", "/");
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setRouteError("Enter a valid npub or Tipstr name.");
      setInputValue(routeValue);
      return;
    }

    const normalizedName = normalizeTipstrName(routeValue);
    setRouteError("Checking Tipstr name ownership...");

    try {
      const owner = await resolveTipstrName(normalizedName);

      if (!owner) {
        window.history.pushState({}, "", buildTipstrNamePath(normalizedName));
        lastAutoGeneratedRouteRef.current = null;
        setActiveNpub(null);
        setActiveTipstrName(null);
        setRouteAmount(null);
        setRouteError("That Tipstr name is not claimed.");
        setInputValue(normalizedName);
        return;
      }

      window.history.pushState({}, "", buildTipstrNamePath(owner.name));
      lastAutoGeneratedRouteRef.current = null;
      setRouteError("");
      setRouteAmount(null);
      setActiveNpub(owner.npub);
      setActiveTipstrName(owner.name);
      setInputValue(owner.name);
    } catch {
      window.history.pushState({}, "", buildTipstrNamePath(normalizedName));
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setRouteError("Unable to resolve that Tipstr name from relays.");
      setInputValue(normalizedName);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCopied(false);
    setCopiedNpub(false);
    setCopiedLightning(false);

    const npub = inputValue.trim();

    if (!isValidNpub(npub)) {
      window.history.pushState({}, "", "/");
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setActiveTipstrName(null);
      setRouteAmount(null);
      setRouteError("Enter a valid npub.");
      setInputValue("");
      return;
    }

    void navigateToProfile(npub);
  }

  async function handleGenerateInvoice() {
    if (!activeNpub || !profileState || profileState.npub !== activeNpub || !lnurlPay) {
      return;
    }

    const currentNpub = activeNpub;
    setIsLoadingInvoice(true);
    setInvoiceError("");
    setCopied(false);
    setCopiedLightning(false);
    setPaymentStatus("idle");

    try {
      const nextInvoice = await fetchInvoice(
        lnurlPay,
        selectedAmount,
        note,
        profileState.pubkey,
      );
      if (activeNpub !== currentNpub) {
        return;
      }
      setInvoice(nextInvoice);
      const nextPath = buildAmountPath(activePathName || profileState.npub, selectedAmount);
      window.history.replaceState({}, "", nextPath);
      setRouteAmount(selectedAmount);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to generate an invoice.";
      setInvoice(null);
      setInvoiceError(message);
    } finally {
      setIsLoadingInvoice(false);
    }
  }

  async function handleSignIn() {
    setIsSigningIn(true);
    setAuthError("");
    setAuthStatus("");

    try {
      const user = await signInWithNostr();
      setSignedInUser(user);
      setAuthStatus("Signed in with Nostr.");

      if (!activeNpub) {
        void navigateToProfile(user.npub);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to sign in with Nostr.";
      setAuthError(message);
    } finally {
      setIsSigningIn(false);
    }
  }

  async function handleSaveTipstrName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!signedInUser) {
      return;
    }

    setIsSavingTipstrName(true);
    setAuthError("");
    setAuthStatus("Cross-checking relays for name ownership...");

    try {
      const name = await saveTipstrName(tipstrNameInput, signedInUser);
      setSavedTipstrName(name);
      setTipstrNameInput(name);
      setAuthStatus(`Saved /${name} to Nostr relays.`);
      void navigateToProfile(name);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to save Tipstr name.";
      setAuthError(message);
      setAuthStatus("");
    } finally {
      setIsSavingTipstrName(false);
    }
  }

  async function handleCopyInvoice() {
    if (!invoice?.pr) {
      return;
    }

    const didCopy = await copyText(invoice.pr);

    if (didCopy) {
      resetCopiedState(setCopied);
    }
  }

  async function handleCopyNpub() {
    if (!activeNpub) {
      return;
    }

    const didCopy = await copyText(activeNpub);

    if (didCopy) {
      resetCopiedState(setCopiedNpub);
    }
  }

  async function handleCopyLightning() {
    if (!lightningAddress) {
      return;
    }

    const didCopy = await copyText(lightningAddress);

    if (didCopy) {
      resetCopiedState(setCopiedLightning);
    }
  }

  function handleSelectAmount(amount: number) {
    setSelectedAmount(amount);
    setCustomAmountInput(String(amount));
  }

  function handleCustomAmountChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const nextValue = event.target.value;
    setCustomAmountInput(nextValue);

    if (nextValue === "") {
      setSelectedAmount(0);
      return;
    }

    const parsedAmount = Number(nextValue);

    if (!Number.isNaN(parsedAmount)) {
      setSelectedAmount(parsedAmount);
    }
  }

  const authTriggerLabel = signedInUser
    ? savedTipstrName
      ? `/${savedTipstrName}`
      : `${signedInUser.npub.slice(0, 6)}...${signedInUser.npub.slice(-4)}`
    : "Sign in";

  const authControls = (
    <>
      <button
        type="button"
        className="auth-trigger"
        onClick={() => setIsAuthModalOpen(true)}
      >
        <span>{authTriggerLabel}</span>
      </button>

      {isAuthModalOpen && (
        <div
          className="auth-modal-backdrop"
          role="presentation"
          onClick={() => setIsAuthModalOpen(false)}
        >
          <section
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="auth-modal-close"
              aria-label="Close sign in modal"
              onClick={() => setIsAuthModalOpen(false)}
            >
              ×
            </button>

            <div className="auth-copy">
              <span className="landing-kicker">Tipstr names</span>
              <h2 id="auth-modal-title">Claim a short link.</h2>
              <p>
                Sign in with a NIP-07 extension to save a Tipstr name to Nostr
                relays. Then your page can use <code>/name</code> instead of
                only <code>/npub...</code>.
              </p>
            </div>

            {!signedInUser ? (
              <button
                type="button"
                className="primary-button auth-button"
                disabled={isSigningIn}
                onClick={() => void handleSignIn()}
              >
                {isSigningIn ? "Opening signer..." : "Sign in with Nostr"}
              </button>
            ) : (
              <form className="tipstr-name-form" onSubmit={handleSaveTipstrName}>
                <p className="signed-in-label">
                  Signed in as {signedInUser.npub.slice(0, 14)}...
                  {signedInUser.npub.slice(-8)}
                </p>
                <label className="field-label" htmlFor="tipstr-name">
                  Tipstr profile name
                </label>
                <div className="npub-row">
                  <input
                    id="tipstr-name"
                    name="tipstr-name"
                    value={tipstrNameInput}
                    onChange={(event) => {
                      hasEditedTipstrNameRef.current = true;
                      setTipstrNameInput(normalizeTipstrName(event.target.value));
                    }}
                    placeholder="your-name"
                    maxLength={20}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    disabled={!tipstrNameInput.trim() || isSavingTipstrName}
                  >
                    {isSavingTipstrName ? "Saving..." : "Save name"}
                  </button>
                </div>
                {savedTipstrName && (
                  <p className="success-box">
                    Current Tipstr link: <code>/{savedTipstrName}</code>
                  </p>
                )}
              </form>
            )}

            {isSavingTipstrName && (
              <div className="auth-loading-row" role="status" aria-live="polite">
                <span className="auth-spinner" aria-hidden="true" />
                <span>{authStatus || "Saving Tipstr name..."}</span>
              </div>
            )}
            {authStatus && !isSavingTipstrName && (
              <p className="success-box">{authStatus}</p>
            )}
            {authError && <p className="error-box">{authError}</p>}
          </section>
        </div>
      )}
    </>
  );

  if (!activeNpub && !isResolvingInitialRoute) {
    return (
      <main className="page-shell home-shell">
        <section className="landing-card">
          {authControls}
          <div className="landing-intro">
            <span className="landing-kicker">Nostr tipping</span>
            <h1>Create your Nostr tip page.</h1>
            <p>
              Tipstr takes your <strong>Nostr</strong> public key and creates a
              page you can share to receive <strong>Lightning</strong> tips.
            </p>
          </div>

          <div className="landing-section landing-steps">
            <h2>How to set it up</h2>
            <ol>
              <li>
                Create a <strong>Nostr</strong> account.
              </li>
              <li>
                Add a <strong>Lightning</strong> address to your{" "}
                <strong>Nostr</strong> profile.
              </li>
              <li>
                Paste your <strong>npub</strong> below to open your page.
              </li>
              <li>Sign in and claim a short link name.</li>
              <li>Share the link and start receiving tips.</li>
            </ol>
          </div>

          <div className="landing-section">
            <h2>Pre-fill a tip amount</h2>
            <p>
              Add an amount in sats to the end of any tip link, like{" "}
              <code>/npub1.../12000</code>, to automatically generate that
              invoice when the page loads.
            </p>
          </div>

          <p className="landing-note">
            New to <strong>Nostr</strong>? Visit{" "}
            <a href="https://primal.net" target="_blank" rel="noreferrer">
              Primal.net
            </a>{" "}
            to create an account, set up your profile, and find your{" "}
            <strong>npub</strong> and <strong>Lightning</strong> address.
          </p>

          <form className="npub-form landing-form" onSubmit={handleSubmit}>
            <div className="npub-row">
              <input
                id="npub-input"
                name="npub"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                placeholder="Enter your npub"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" disabled={!inputValue.trim()}>
                Create my link
              </button>
            </div>
          </form>

          {routeError && <p className="error-box">{routeError}</p>}
        </section>
        {builderCredit}
      </main>
    );
  }

  return (
    <main className="page-shell">
      <section className="content-stack app-layout">
        <article className="profile-card profile-panel">
          <div
            className="banner"
            style={{
              backgroundImage: profileState?.profile?.banner
                ? `url(${profileState.profile.banner})`
                : undefined,
            }}
          >
            {!profileState?.profile?.banner && (
              <div className="banner-fallback" />
            )}
            {authControls}
          </div>

          <div className="profile-body">
            <div className="identity-row">
              <div className="avatar-wrap">
                {profileState?.profile?.picture ? (
                  <img
                    className="avatar"
                    src={profileState.profile.picture}
                    alt={title}
                  />
                ) : (
                  <div className="avatar avatar-fallback">
                    {title.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>

              <div className="identity-copy">
                <h2>{title}</h2>
                {profileState?.profile?.about && (
                  <>
                    <p
                      ref={bioRef}
                      className={isBioExpanded ? "bio bio-expanded" : "bio"}
                    >
                      {profileState.profile.about}
                    </p>
                    {(isBioExpanded || isBioTruncated) && (
                      <button
                        type="button"
                        className="bio-toggle"
                        onClick={() => {
                          setIsBioExpanded((current) => !current);
                        }}
                      >
                        {isBioExpanded ? "Show less" : "Show more"}
                      </button>
                    )}
                  </>
                )}
                <p className="handle">{handle}</p>
              </div>
            </div>

            <div className="profile-summary">
              <div className="meta-row">
                {profileState?.profile?.nip05 && (
                  <span
                    className={
                      nip05Status === "verified"
                        ? "meta-badge nip05-badge verified"
                        : nip05Status === "invalid"
                          ? "meta-badge nip05-badge invalid"
                          : "meta-badge nip05-badge checking"
                    }
                  >
                    <span className="nip05-icon" aria-hidden="true">
                      {nip05Status === "verified"
                        ? "✓"
                        : nip05Status === "invalid"
                          ? "✕"
                          : "•"}
                    </span>
                    <span>{profileState.profile.nip05}</span>
                    <span className="nip05-label">{nip05Label}</span>
                  </span>
                )}
                {websiteUrl && websiteLabel && (
                  <a
                    href={websiteUrl.toString()}
                    target="_blank"
                    rel="noreferrer"
                    className="meta-badge meta-link"
                  >
                    <span>Website</span>
                    <span className="meta-button-label">{websiteLabel}</span>
                  </a>
                )}
                {lightningAddress && (
                  <button
                    type="button"
                    className="meta-badge meta-button"
                    onClick={() => void handleCopyLightning()}
                  >
                    <span>Lightning</span>
                    <span className="meta-button-label">
                      {copiedLightning
                        ? `✓ ${lightningAddress}`
                        : lightningAddress}
                    </span>
                  </button>
                )}
                {!lightningAddress && lightningLabel && (
                  <span className="meta-badge">
                    <span>Lightning</span>
                    <span className="meta-button-label">{lightningLabel}</span>
                  </span>
                )}
                <button
                  type="button"
                  className="meta-badge meta-button"
                  onClick={() => void handleCopyNpub()}
                >
                  <span>
                    {copiedNpub ? `✓ ${npubLabel}` : npubLabel}
                  </span>
                </button>
              </div>
            </div>

            {profileError && <p className="error-box">{profileError}</p>}
          </div>
        </article>

        <aside className="tip-card tip-panel">
          <div className="tip-header">
            <h3>Send tip</h3>
          </div>

          <div className="amount-grid">
            {PRESET_AMOUNTS.map((amount) => (
              <button
                key={amount}
                type="button"
                className={
                  amount === selectedAmount
                    ? "amount-chip active"
                    : "amount-chip"
                }
                onClick={() => handleSelectAmount(amount)}
              >
                {amount.toLocaleString()} sats
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="custom-amount">
            Custom amount
          </label>
          <input
            id="custom-amount"
            className="field-input"
            type="number"
            min={amountRange?.min ?? 1}
            max={amountRange?.max ?? 1000000}
            value={customAmountInput}
            onChange={handleCustomAmountChange}
          />

          <div className="note-row">
            <button
              type="button"
              className={
                showNoteField
                  ? "secondary-button note-toggle active"
                  : "secondary-button note-toggle"
              }
              onClick={() => setShowNoteField((current) => !current)}
            >
              {showNoteField ? "Hide note" : "Add note"}
            </button>
          </div>

          {showNoteField && (
            <>
              <label className="field-label" htmlFor="tip-note">
                Message
              </label>
              <textarea
                id="tip-note"
                className="field-input field-textarea"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={DEFAULT_TIP_NOTE}
              />
            </>
          )}

          <button
            type="button"
            className="primary-button"
            disabled={
              isLoadingProfile ||
              isLoadingInvoice ||
              !profileState ||
              profileState.npub !== activeNpub ||
              !lnurlPay ||
              selectedAmount <= 0
            }
            onClick={() => void handleGenerateInvoice()}
          >
            {isLoadingInvoice ? "Generating invoice..." : "Tip Now"}
          </button>

          {invoiceError && <p className="error-box">{invoiceError}</p>}
        </aside>
      </section>

      {(paymentStatus === "paid" || invoice?.pr) && (
        <section ref={invoiceSectionRef} className="invoice-section">
          {paymentStatus === "paid" && (
            <div className="payment-success-card invoice-stage-card">
              <span className="payment-success-kicker">Confirmed</span>
              <h4>Payment sent</h4>
              <p>
                The invoice has been paid and the donation was detected
                successfully.
              </p>
            </div>
          )}

          {invoice?.pr && paymentStatus !== "paid" && (
            <div className="invoice-card invoice-stage-card">
              <div className="invoice-stage-header">
                <span className="landing-kicker">Invoice</span>
                <h3>Complete your payment</h3>
              </div>

              {paymentStatus !== "unsupported" && (
                <div className="payment-status-row">
                  <span className="payment-status-dot" aria-hidden="true" />
                  <span>
                    {paymentStatus === "awaiting"
                      ? "Waiting for payment confirmation..."
                      : "Preparing payment confirmation..."}
                  </span>
                </div>
              )}

              {paymentStatus === "unsupported" && (
                <p className="payment-note">
                  Live confirmation is unavailable for this invoice. You can
                  still pay with the QR code below.
                </p>
              )}

              <div className="qr-wrap">
                <QRCodeSVG
                  value={invoice.pr}
                  size={188}
                  bgColor="transparent"
                  fgColor="#5a3a0a"
                />
              </div>

              <div className="invoice-copy">
                <p>Scan the QR code or copy the invoice string.</p>
                <code>{invoice.pr}</code>
              </div>

              <div className="invoice-actions">
                <button
                  type="button"
                  className="secondary-button invoice-copy-button"
                  onClick={() => void handleCopyInvoice()}
                >
                  <span>{copied ? "✓ Copy invoice" : "Copy invoice"}</span>
                </button>
                {invoice.verify && (
                  <a
                    href={invoice.verify}
                    target="_blank"
                    rel="noreferrer"
                    className="secondary-link"
                  >
                    Verify payment
                  </a>
                )}
              </div>
            </div>
          )}
        </section>
      )}
      {builderCredit}
    </main>
  );
}

export default App;
