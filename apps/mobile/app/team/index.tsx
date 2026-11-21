import React, { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Stack, router, useFocusEffect } from "expo-router";
import { useApp } from "../../src/state";
import { C, DevBanner, s } from "../../src/ui";
import { errorText, type TeamMember, type TeamRole } from "../../src/team";

/** Team & roles on the phone: everyone with members.read sees it; people with roles.manage can change it. */
export default function Team() {
  const app = useApp();
  const canManage = app.can("roles.manage");
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const base = app.session ? `/v1/orgs/${app.session.orgId}` : "";

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    try {
      const [m, r] = await Promise.all([
        app.api.get<{ items: TeamMember[] }>(`${base}/team/members`),
        app.api.get<{ items: TeamRole[] }>(`${base}/team/roles`),
      ]);
      setMembers(m.items);
      setRoles(r.items);
      setNote(null);
      void app.refreshPermissions();
    } catch (e) {
      setNote(errorText(e).replace(" Nothing was changed.", ""));
    } finally {
      setLoading(false);
    }
  }, [app, base]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <View style={s.screen}>
      <Stack.Screen
        options={{
          title: "Team & Roles",
          headerRight: canManage
            ? () => (
                <Pressable hitSlop={12} onPress={() => router.push({ pathname: "/team/role/[id]", params: { id: "new" } })}>
                  <Text style={{ color: C.link, fontSize: 16 }}>New Role</Text>
                </Pressable>
              )
            : undefined,
        }}
      />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
        <Text style={s.muted}>
          A role is a set of things a person is allowed to do.{" "}
          {canManage ? "Tap a person to change their roles, or a role to change what it allows." : "Only owners can change roles."}
        </Text>
        {note ? <Text style={s.error}>{note}</Text> : null}

        <Text style={s.label}>PEOPLE</Text>
        <View style={[s.card, { paddingVertical: 0 }]}>
          {members.map((m, i) => (
            <Row
              key={m.membershipId}
              last={i === members.length - 1}
              title={`${m.displayName}${m.isYou ? " (you)" : ""}`}
              sub={[m.roles.map((r) => r.name).join(", ") || "No role", m.status !== "active" ? m.status : ""].filter(Boolean).join(" · ")}
              onPress={canManage ? () => router.push({ pathname: "/team/member/[id]", params: { id: m.membershipId, name: m.displayName } }) : undefined}
            />
          ))}
        </View>
        <Text style={[s.muted, { fontSize: 13 }]}>Adding new people needs the real sign-in system, which isn't built yet.</Text>

        <Text style={[s.label, { marginTop: 8 }]}>ROLES</Text>
        <View style={[s.card, { paddingVertical: 0 }]}>
          {roles.map((r, i) => (
            <Row
              key={r.id}
              last={i === roles.length - 1}
              title={r.name}
              badge={r.builtIn ? "Built-in" : "Custom"}
              sub={`${r.memberCount} ${r.memberCount === 1 ? "person" : "people"} · ${r.locked ? "Always has every permission" : `${r.permissions.length} permissions`}`}
              onPress={() => router.push({ pathname: "/team/role/[id]", params: { id: r.id } })}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Row(props: { title: string; sub: string; badge?: string; last: boolean; onPress?: () => void }) {
  return (
    <Pressable
      disabled={!props.onPress}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        borderBottomWidth: props.last ? 0 : 1,
        borderBottomColor: C.line,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: C.text, fontSize: 16, fontWeight: "600" }}>{props.title}</Text>
          {props.badge ? (
            <View style={[s.pill, { backgroundColor: C.line }]}>
              <Text style={[s.pillText, { color: C.muted }]}>{props.badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[s.muted, { marginTop: 2 }]}>{props.sub}</Text>
      </View>
      {props.onPress ? <Text style={{ color: C.muted, fontSize: 22, marginLeft: 8 }}>›</Text> : null}
    </Pressable>
  );
}
