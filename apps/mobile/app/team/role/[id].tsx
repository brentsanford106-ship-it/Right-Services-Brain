import React, { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useApp } from "../../../src/state";
import { Button, C, DevBanner, s } from "../../../src/ui";
import { CheckRow, errorText, holds, type PermissionInfo, type TeamRole } from "../../../src/team";

/** Create or edit a role. id = "new" for a new custom role. Read-only for people without roles.manage and for the Owner role. */
export default function RoleEditor() {
  const app = useApp();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const base = `/v1/orgs/${app.session!.orgId}`;
  const [role, setRole] = useState<TeamRole | null>(null);
  const [catalog, setCatalog] = useState<PermissionInfo[] | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [showUnused, setShowUnused] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [p, r] = await Promise.all([
          app.api.get<{ items: PermissionInfo[] }>(`${base}/team/permissions`),
          isNew ? Promise.resolve(null) : app.api.get<{ items: TeamRole[] }>(`${base}/team/roles`),
        ]);
        setCatalog(p.items);
        if (r) {
          const found = r.items.find((x) => x.id === id) ?? null;
          setRole(found);
          setName(found?.name ?? "");
          setPicked(new Set(found?.permissions ?? []));
        }
      } catch (e) {
        setNote(errorText(e));
      }
    })();
  }, [app.api, base, id, isNew]);

  const editable = app.can("roles.manage") && !role?.locked && (isNew || !!role);
  const groups = useMemo(() => {
    const g = new Map<string, PermissionInfo[]>();
    for (const p of catalog ?? []) {
      if (!p.inUse && !showUnused && !picked.has(p.key)) continue;
      g.set(p.group, [...(g.get(p.group) ?? []), p]);
    }
    return [...g.entries()];
  }, [catalog, showUnused, picked]);

  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), permissions: [...picked] };
      if (isNew) await app.api.post(`${base}/team/roles`, body);
      else await app.api.patch(`${base}/team/roles/${id}`, body);
      await app.refreshPermissions();
      router.back();
    } catch (e) {
      Alert.alert("Not saved", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    Alert.alert(`Delete the role "${role?.name}"?`, "This can't be undone. Anyone who has it must be given another role first.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete Role",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            await app.api.delete(`${base}/team/roles/${id}`);
            router.back();
          } catch (e) {
            Alert.alert("Not deleted", errorText(e));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);

  const loaded = catalog && (isNew || role);
  return (
    <View style={s.screen}>
      <Stack.Screen options={{ title: isNew ? "New Role" : (role?.name ?? "Role") }} />
      <DevBanner />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }} keyboardShouldPersistTaps="handled">
        {note ? <Text style={s.error}>{note}</Text> : null}
        {!loaded && !note ? <ActivityIndicator color={C.muted} /> : null}
        {loaded ? (
          <>
            {role?.locked ? (
              <Text style={s.muted}>The Owner role always has every permission. It can't be changed, so the company is never locked out.</Text>
            ) : !editable ? (
              <Text style={s.muted}>Only owners can change roles. This is what the role allows.</Text>
            ) : (
              <Text style={s.muted}>Tick what people with this role may do. Greyed-out items are ones you don't have yourself, so you can't give them out.</Text>
            )}
            <View>
              <Text style={s.label}>Role name</Text>
              <TextInput
                style={[s.input, !editable && { opacity: 0.6 }]}
                value={name}
                onChangeText={setName}
                editable={editable}
                maxLength={60}
                placeholder="e.g. Lead Technician"
                placeholderTextColor={C.muted}
                returnKeyType="done"
              />
            </View>
            {groups.map(([group, items]) => (
              <View key={group}>
                <Text style={s.label}>{group.toUpperCase()}</Text>
                <View style={[s.card, { paddingVertical: 0 }]}>
                  {items.map((p) => (
                    <CheckRow
                      key={p.key}
                      label={p.label}
                      sub={p.inUse ? undefined : "Not used yet"}
                      checked={role?.locked ? true : picked.has(p.key)}
                      disabled={!editable || busy || !holds(app.can, p.key)}
                      onToggle={() =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.key)) next.delete(p.key);
                          else next.add(p.key);
                          return next;
                        })
                      }
                    />
                  ))}
                </View>
              </View>
            ))}
            {catalog?.some((p) => !p.inUse) ? (
              <Button
                kind="secondary"
                title={showUnused ? "Hide features that aren't built yet" : "Show features that aren't built yet"}
                onPress={() => setShowUnused((v) => !v)}
              />
            ) : null}
            {editable ? <Button title={isNew ? "Create Role" : "Save"} onPress={() => void save()} disabled={!name.trim()} busy={busy} /> : null}
            {editable && role && !role.builtIn ? <Button kind="danger" title="Delete Role" onPress={remove} disabled={busy} /> : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
