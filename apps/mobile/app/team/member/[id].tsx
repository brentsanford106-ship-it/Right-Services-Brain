import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useApp } from "../../../src/state";
import { Button, C, DevBanner, s } from "../../../src/ui";
import { CheckRow, errorText, holds, type TeamMember, type TeamRole } from "../../../src/team";

/** Choose one person's roles. The server refuses anything you aren't allowed to do and explains why. */
export default function MemberRoles() {
  const app = useApp();
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const base = `/v1/orgs/${app.session!.orgId}`;
  const [member, setMember] = useState<TeamMember | null>(null);
  const [roles, setRoles] = useState<TeamRole[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, r] = await Promise.all([
          app.api.get<{ items: TeamMember[] }>(`${base}/team/members`),
          app.api.get<{ items: TeamRole[] }>(`${base}/team/roles`),
        ]);
        const found = m.items.find((x) => x.membershipId === id) ?? null;
        setMember(found);
        setRoles(r.items);
        setPicked(new Set(found?.roles.map((x) => x.id) ?? []));
      } catch (e) {
        setNote(errorText(e));
      }
    })();
  }, [app.api, base, id]);

  const ownerRole = roles.find((r) => r.key === "owner");
  const removingOwnOwner = !!member?.isYou && member.roles.some((r) => r.key === "owner") && !!ownerRole && !picked.has(ownerRole.id);

  const save = async () => {
    setBusy(true);
    try {
      await app.api.patch(`${base}/team/members/${id}`, { roleIds: [...picked] });
      await app.refreshPermissions();
      router.back();
    } catch (e) {
      Alert.alert("Not saved", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmSave = () => {
    if (!removingOwnOwner) return void save();
    Alert.alert("Remove your own Owner role?", "You'll lose owner abilities, including this screen. This only works if someone else is also an owner.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void save() },
    ]);
  };

  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: name ?? member?.displayName ?? "Roles" }} />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }}>
        {note ? <Text style={s.error}>{note}</Text> : null}
        {!member && !note ? <ActivityIndicator color={C.muted} /> : null}
        {member ? (
          <>
            <Text style={s.muted}>
              Choose {member.isYou ? "your" : `${member.displayName}'s`} roles. People get everything allowed by all of their roles together.
            </Text>
            <View style={[s.card, { paddingVertical: 0 }]}>
              {roles.map((r) => {
                const allowed = r.permissions.every((p) => holds(app.can, p));
                return (
                  <CheckRow
                    key={r.id}
                    label={r.name}
                    sub={allowed ? `${r.locked ? "Everything" : `${r.permissions.length} permissions`}` : "Has permissions you don't have, so you can't change it"}
                    checked={picked.has(r.id)}
                    disabled={!allowed || busy}
                    onToggle={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      })
                    }
                  />
                );
              })}
            </View>
            {picked.size === 0 ? <Text style={s.muted}>Everyone needs at least one role.</Text> : null}
            <Button title="Save" onPress={confirmSave} disabled={picked.size === 0} busy={busy} />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
