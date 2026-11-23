import React, { useEffect, useState } from "react";
import { Image as RNImage, Text, View, type ImageStyle, type StyleProp } from "react-native";
import { Image } from "expo-image";
import { initials, personColor, syncStateOf, type PhotoQueue, type QueuedPhoto, type Stage, type SyncState } from "@rsb/photo-sync";
import { useApp } from "./state";
import { C } from "./ui";

/** A photo as the server describes it. */
export interface ServerPhoto {
  id: string;
  jobId: string;
  jobNumber: string;
  stage: Stage | "issue" | "other";
  note: string | null;
  flagged: boolean;
  capturedAt: string;
  uploadStatus: "pending" | "stored" | "rejected";
  uploadedBy: string;
  /** Who took it. null = unknown (an imported photo). Missing on copies saved by older app versions. */
  photographerId?: string | null;
  photographer?: string | null;
  takenByMe?: boolean;
  uploadedByMe?: boolean;
  captureSource?: "in_app_camera" | "imported" | "web_upload";
  capturedAtKnown?: boolean;
  photographerAvatarAt?: string | null;
  hasPreview: boolean;
  /** Comments and replies (not deleted). Missing on copies saved by older app versions. */
  commentCount?: number;
  /** Marks drawn on the photo. */
  markupCount?: number;
  /** Issues on the photo that aren't fixed yet. */
  openIssueCount?: number;
  /** Size of the display copy (what drawings are measured against). */
  widthPx?: number | null;
  heightPx?: number | null;
  /** Server's answer to "may I delete this?" (for hiding buttons; the server still checks). */
  canDelete?: boolean;
  latitude: number | null;
  longitude: number | null;
}

/** One tile in a gallery: either a photo on this phone, a photo on the server, or both. */
export interface GalleryItem {
  key: string; // "l:<localId>" or "s:<serverId>"
  capturedAt: string;
  stage: string;
  flagged: boolean;
  note: string | null;
  state: SyncState | "server" | "server_missing_file";
  local: QueuedPhoto | null;
  server: ServerPhoto | null;
  /** Who took it: "me", a person's id, or "unknown" (for the People filter). */
  personKey: string;
  /** Their name; null when unknown. */
  personName: string | null;
  /** Their id in the company (for their profile picture) and when the picture last changed; null = show initials. */
  personId: string | null;
  personAvatarAt: string | null;
}

export interface Me {
  name: string;
  membershipId: string | null;
  avatarAt: string | null;
}

/** Who took a photo, from the phone's point of view. Photos still only on this phone are mine, unless imported. */
function who(sp: ServerPhoto | null, local: QueuedPhoto | null, me: Me): Pick<GalleryItem, "personKey" | "personName" | "personId" | "personAvatarAt"> {
  const mine = { personKey: "me", personName: me.name, personId: me.membershipId, personAvatarAt: me.avatarAt };
  const unknown = { personKey: "unknown", personName: null, personId: null, personAvatarAt: null };
  if (!sp) return local?.captureSource === "imported" ? unknown : mine;
  // Older cached copies have no photographer fields: until then every photo was taken in the app by its uploader.
  if (sp.photographerId === undefined) {
    return sp.uploadedBy === me.name ? mine : { personKey: `name:${sp.uploadedBy}`, personName: sp.uploadedBy, personId: null, personAvatarAt: null };
  }
  if (sp.photographerId === null) return unknown;
  if (sp.takenByMe) return { ...mine, personName: sp.photographer ?? me.name, personId: sp.photographerId, personAvatarAt: sp.photographerAvatarAt ?? null };
  return { personKey: sp.photographerId, personName: sp.photographer ?? null, personId: sp.photographerId, personAvatarAt: sp.photographerAvatarAt ?? null };
}

export type Filter = "all" | Stage | "flagged" | "comments" | "issues";

export function mergeGallery(queue: PhotoQueue, jobId: string, server: ServerPhoto[], uploadingId: string | null, me: Me = { name: "", membershipId: null, avatarAt: null }): GalleryItem[] {
  const out: GalleryItem[] = [];
  const localByServer = new Map<string, QueuedPhoto>();
  for (const p of queue.forJob(jobId)) {
    if (p.serverId) localByServer.set(p.serverId, p);
    if (p.remoteOnly) continue; // shown via its server entry, with local edits applied below
    const sp = p.serverId ? server.find((x) => x.id === p.serverId) ?? null : null;
    out.push({ key: `l:${p.localId}`, capturedAt: p.capturedAt, stage: p.stage, flagged: p.flagged, note: p.note, state: syncStateOf(p, uploadingId), local: p, server: sp, ...who(sp, p, me) });
  }
  for (const sp of server) {
    const lp = localByServer.get(sp.id);
    if (lp && !lp.remoteOnly) continue;
    out.push({
      key: `s:${sp.id}`,
      capturedAt: sp.capturedAt,
      stage: lp?.stage ?? sp.stage,
      flagged: lp?.flagged ?? sp.flagged,
      note: lp ? lp.note : sp.note,
      state: lp ? syncStateOf(lp, uploadingId) : sp.uploadStatus === "stored" ? "server" : "server_missing_file",
      local: lp ?? null,
      server: sp,
      ...who(sp, lp ?? null, me),
    });
  }
  return out.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function applyFilter(items: GalleryItem[], f: Filter): GalleryItem[] {
  if (f === "all") return items;
  if (f === "flagged") return items.filter((i) => i.flagged);
  if (f === "comments") return items.filter((i) => (i.server?.commentCount ?? 0) > 0);
  if (f === "issues") return items.filter((i) => (i.server?.openIssueCount ?? 0) > 0);
  return items.filter((i) => i.stage === f);
}

/** Thumbnail of a photo stored (encrypted) on this phone. Decrypted in memory only. */
export function LocalImage({ localId, which, style }: { localId: string; which: "thumbnail" | "original"; style: StyleProp<ImageStyle> }) {
  const { queue } = useApp();
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let b64 = await queue.imageBase64(localId, which);
        if (!b64 && which === "original") b64 = await queue.imageBase64(localId, "thumbnail");
        if (live && b64) setUri(`data:image/jpeg;base64,${b64}`);
      } catch {
        if (live) setUri(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [localId, which, queue]);
  if (!uri) return <View style={[style as object, { backgroundColor: C.line }]} />;
  return <RNImage source={{ uri }} style={style} resizeMode={which === "original" ? "contain" : "cover"} />;
}

/**
 * Image from the server. Every request carries the access token (there are no shareable links).
 * Cached in memory only, so server images are not written to the phone's disk.
 */
export function ServerImage({ photoId, style, contain, thumb }: { photoId: string; style: StyleProp<ImageStyle>; contain?: boolean; thumb?: boolean }) {
  const app = useApp();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    void app.token().then(setToken);
  }, [app]);
  if (!token) return <View style={[style as object, { backgroundColor: C.line }]} />;
  return (
    <Image
      source={{ uri: `${app.server}/v1/orgs/${app.session!.orgId}/photos/${photoId}/content${thumb ? "?variant=thumb" : ""}`, headers: { Authorization: `Bearer ${token}` } }}
      style={style}
      contentFit={contain ? "contain" : "cover"}
      cachePolicy="memory"
      transition={150}
    />
  );
}

/** Someone's profile picture, or a colored circle with their initials when they have none. */
export function PersonBadge({ personKey, name, personId, avatarAt, size = 22 }: { personKey: string; name: string | null; personId?: string | null; avatarAt?: string | null; size?: number }) {
  const app = useApp();
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const wantsPicture = !!personId && !!avatarAt && !failed;
  useEffect(() => {
    if (wantsPicture) void app.token().then(setToken);
  }, [app, wantsPicture]);
  const ring = { width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.9)" } as const;
  const label = name ? `Taken by ${name}` : "Who took this is unknown";
  if (wantsPicture && token) {
    return (
      <Image
        accessibilityLabel={label}
        // The version in the address makes a changed picture load fresh. Kept in memory only, like photos.
        source={{ uri: `${app.server}/v1/orgs/${app.session!.orgId}/members/${personId}/avatar?v=${encodeURIComponent(avatarAt!)}`, headers: { Authorization: `Bearer ${token}` } }}
        style={ring}
        contentFit="cover"
        cachePolicy="memory"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <View accessibilityLabel={label} style={[ring, { backgroundColor: personColor(personKey === "unknown" ? null : personKey), alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ color: "#fff", fontWeight: "800", fontSize: Math.round(size * 0.42) }}>{initials(name)}</Text>
    </View>
  );
}
