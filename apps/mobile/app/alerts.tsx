import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { alertAge, alertText } from "@rsb/photo-sync";
import { useApp } from "../src/state";
import { type ServerAlert } from "../src/alerts";
import { openIssuePhoto } from "../src/issues";
import { PersonBadge } from "../src/photos";
import { C, DevBanner, Empty, s } from "../src/ui";

/** My alerts: mentions, replies, comments on my photos, and issue steps. Tap one to open the photo. */
export default function Alerts() {
  const app = useApp();
  const orgId = app.session?.orgId ?? "";
  const [items, setItems] = useState<ServerAlert[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await app.api.get<{ items: ServerAlert[]; unreadCount: number }>(`/v1/orgs/${orgId}/notifications?limit=100`);
      setItems(r.items);
      setUnread(r.unreadCount);
      setOffline(false);
      await app.cache.put("alerts", r.items);
    } catch {
      setOffline(true);
      const cached = await app.cache.get<ServerAlert[]>("alerts");
      setItems((cur) => cur ?? cached ?? []);
    } finally {
      setLoading(false);
    }
  }, [app.api, app.cache, orgId]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const markRead = async (body: { ids?: string[]; all?: boolean }) => {
    try {
      const r = await app.api.post<{ unreadCount: number }>(`/v1/orgs/${orgId}/notifications/read`, body);
      setUnread(r.unreadCount);
      const now = new Date().toISOString();
      setItems((cur) => cur?.map((n) => (body.all || body.ids?.includes(n.id) ? { ...n, readAt: n.readAt ?? now } : n)) ?? cur);
    } catch {
      // Offline: it stays unread and is marked next time.
    }
  };
  const open = (n: ServerAlert) => {
    if (!n.readAt) void markRead({ ids: [n.id] });
    void openIssuePhoto(app, n.jobId, n.photoId);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Alerts",
          headerRight: () => (unread ? (
            <Pressable hitSlop={12} onPress={() => void markRead({ all: true })}>
              <Text style={{ color: C.link, fontSize: 16 }}>Mark all read</Text>
            </Pressable>
          ) : null),
        }}
      />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        {offline ? <Text style={s.muted}>Offline: showing alerts saved on this phone.</Text> : null}
        {items && !items.length ? <Empty title="No alerts yet" body="Mentions, replies and issues for you show up here." /> : null}
        {(items ?? []).map((n) => (
          <Pressable key={n.id} onPress={() => open(n)} accessibilityRole="button" accessibilityLabel={`${n.readAt ? "" : "New: "}${alertText(n)}`}
            style={({ pressed }) => [s.card, { flexDirection: "row", gap: 10, alignItems: "flex-start", opacity: pressed ? 0.7 : 1, borderLeftWidth: 4, borderLeftColor: n.readAt ? "transparent" : C.brand }]}>
            <PersonBadge personKey={n.actorId} name={n.actor} personId={n.actorId} avatarAt={n.actorAvatarAt} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.text, fontWeight: n.readAt ? "400" : "700" }}>{alertText(n)}</Text>
              {n.snippet ? <Text style={s.muted} numberOfLines={2}>“{n.snippet}”</Text> : null}
            </View>
            <Text style={s.muted}>{alertAge(n.createdAt)}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
