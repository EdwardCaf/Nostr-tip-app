import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  SimplePool,
  finalizeEvent,
  nip19,
  nip57,
  type EventTemplate,
} from "nostr-tools";
import "./App.css";

const pool = new SimplePool();

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];
const PRESET_AMOUNTS = [1000, 10000];
const DEFAULT_TIP_NOTE = "Sent via tipstr.app";

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

const PAYMENT_POLL_INTERVAL_MS = 3000;
const PAYMENT_POLL_TIMEOUT_MS = 120000;

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

function isValidNpub(value: string) {
  try {
    decodeNpub(value);
    return true;
  } catch {
    return false;
  }
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

  throw new Error("This profile does not publish a Lightning address.");
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

function buildProfilePath(npub: string) {
  return `/${npub.trim()}`;
}

function buildAmountPath(npub: string, amount: number) {
  return `/${npub.trim()}/${amount}`;
}

async function fetchProfile(npub: string): Promise<ProfileState> {
  const pubkey = decodeNpub(npub);
  const event = await pool.get(RELAYS, { kinds: [0], authors: [pubkey] });

  if (!event) {
    throw new Error("No profile metadata was found on the selected relays.");
  }

  const profile = parseProfile(event.content);

  if (!profile) {
    throw new Error("The profile metadata could not be parsed.");
  }

  return { pubkey, npub, profile };
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
    !data.callback ||
    !data.minSendable ||
    !data.maxSendable ||
    !data.metadata
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

function resetCopiedState(setter: React.Dispatch<React.SetStateAction<boolean>>) {
  setter(true);
  window.setTimeout(() => {
    setter(false);
  }, 3000);
}

function App() {
  const invoiceSectionRef = useRef<HTMLElement | null>(null);
  const lastAutoGeneratedRouteRef = useRef<string | null>(null);
  const bioRef = useRef<HTMLParagraphElement | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [activeNpub, setActiveNpub] = useState<string | null>(null);
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

  useEffect(() => {
    const { npub: pathNpub, amount: pathAmount } = parseRoute(
      window.location.pathname,
    );
    const queryNpub =
      new URLSearchParams(window.location.search).get("npub")?.trim() || null;

    if (pathNpub) {
      if (isValidNpub(pathNpub)) {
        setActiveNpub(pathNpub);
        setRouteAmount(pathAmount);
        setInputValue(pathNpub);
        setRouteError("");
      } else {
        window.history.replaceState({}, "", "/");
        setActiveNpub(null);
        setRouteAmount(null);
        setInputValue("");
        setRouteError("That URL does not contain a valid npub.");
      }

      return;
    }

    if (queryNpub && isValidNpub(queryNpub)) {
      const nextPath = buildProfilePath(queryNpub);
      window.history.replaceState({}, "", nextPath);
      setActiveNpub(queryNpub);
      setRouteAmount(null);
      setInputValue(queryNpub);
      setRouteError("");
      return;
    }

    setActiveNpub(null);
    setRouteAmount(null);
    setInputValue("");
    setRouteError("");
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
    if (!activeNpub || !profileState || !lnurlPay || !routeAmount || invoice?.pr) {
      return;
    }

    const routeKey = `${activeNpub}:${routeAmount}`;
    const currentLnurlPay = lnurlPay;
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
    let timeoutId: number | undefined;
    let intervalId: number | undefined;

    async function pollPayment() {
      try {
        const isPaid = await checkInvoicePaid(verifyUrl);

        if (cancelled) {
          return;
        }

        if (isPaid) {
          setPaymentStatus("paid");

          if (intervalId) {
            window.clearInterval(intervalId);
          }

          if (timeoutId) {
            window.clearTimeout(timeoutId);
          }
        }
      } catch {
        if (!cancelled) {
          setPaymentStatus("unsupported");

          if (intervalId) {
            window.clearInterval(intervalId);
          }

          if (timeoutId) {
            window.clearTimeout(timeoutId);
          }
        }
      }
    }

    setPaymentStatus("awaiting");
    void pollPayment();

    intervalId = window.setInterval(() => {
      void pollPayment();
    }, PAYMENT_POLL_INTERVAL_MS);

    timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        setPaymentStatus("unsupported");
      }

      if (intervalId) {
        window.clearInterval(intervalId);
      }
    }, PAYMENT_POLL_TIMEOUT_MS);

    return () => {
      cancelled = true;

      if (intervalId) {
        window.clearInterval(intervalId);
      }

      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
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
  const websiteUrl = normalizeWebsiteUrl(profileState?.profile.website);
  const websiteLabel = websiteUrl?.hostname.replace(/^www\./, "") ?? null;
  const lightningAddress = profileState?.profile.lud16 ?? null;
  const lightningLabel = profileState?.profile.lud16 ?? (profileState?.profile.lud06 ? "LNURL enabled" : null);
  const nip05Label =
    nip05Status === "verified"
      ? "Verified"
      : nip05Status === "invalid"
        ? "Unverified"
        : "Checking";

  function navigateToNpub(npub: string) {
    const nextNpub = npub.trim();

    if (!nextNpub) {
      window.history.pushState({}, "", "/");
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setRouteAmount(null);
      setRouteError("That URL does not contain a valid npub.");
      setInputValue("");
      return;
    }

    if (!isValidNpub(nextNpub)) {
      window.history.pushState({}, "", "/");
      lastAutoGeneratedRouteRef.current = null;
      setActiveNpub(null);
      setRouteAmount(null);
      setRouteError("That URL does not contain a valid npub.");
      setInputValue(nextNpub);
      return;
    }

    window.history.pushState({}, "", buildProfilePath(nextNpub));
    lastAutoGeneratedRouteRef.current = null;
    setRouteError("");
    setRouteAmount(null);
    setActiveNpub(nextNpub);
    setInputValue(nextNpub);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCopied(false);
    setCopiedNpub(false);
    setCopiedLightning(false);
    navigateToNpub(inputValue);
  }

  async function handleGenerateInvoice() {
    if (!profileState || !lnurlPay) {
      return;
    }

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
      setInvoice(nextInvoice);
      const nextPath = buildAmountPath(profileState.npub, selectedAmount);
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

  function handleCustomAmountChange(event: React.ChangeEvent<HTMLInputElement>) {
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

  if (!activeNpub) {
    return (
      <main className="page-shell home-shell">
        <section className="landing-card">
          <span className="landing-kicker">Nostr tipping</span>
          <h1>Turn any npub into a tip page.</h1>
          <p>
            Paste a Nostr public key and open a clean Lightning tipping page.
          </p>

          <form className="npub-form landing-form" onSubmit={handleSubmit}>
            <div className="npub-row">
              <input
                id="npub-input"
                name="npub"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                placeholder="Enter npub"
                spellCheck={false}
                autoComplete="off"
              />
              <button type="submit" disabled={!inputValue.trim()}>
                Open page
              </button>
            </div>
          </form>

          {routeError && <p className="error-box">{routeError}</p>}
        </section>
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
                      {copiedLightning ? `✓ ${lightningAddress}` : lightningAddress}
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
                    {copiedNpub
                      ? `✓ ${activeNpub.slice(0, 18)}...${activeNpub.slice(-8)}`
                      : `${activeNpub.slice(0, 18)}...${activeNpub.slice(-8)}`}
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
    </main>
  );
}

export default App;
