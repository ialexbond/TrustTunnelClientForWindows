import { useState } from "react";

/**
 * Domain hook for user-management state within the server panel.
 * Owns ephemeral form and selection state only — actions (add/delete/export)
 * live in UsersSection and call invoke() + useConfirm() directly, because
 * they also need access to `runAction` / `addUserToState` from useServerState
 * for optimistic updates.
 *
 * Usage:
 *   const users = useUsersState();
 *   // pass users into section, destructure fields
 */
export function useUsersState() {
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPw, setShowNewPw] = useState(false);
  const [exportingUser, setExportingUser] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [continueLoading, setContinueLoading] = useState(false);

  return {
    selectedUser,
    setSelectedUser,
    newUsername,
    setNewUsername,
    newPassword,
    setNewPassword,
    showNewPw,
    setShowNewPw,
    exportingUser,
    setExportingUser,
    deleteLoading,
    setDeleteLoading,
    continueLoading,
    setContinueLoading,
  };
}

export type UsersState = ReturnType<typeof useUsersState>;
