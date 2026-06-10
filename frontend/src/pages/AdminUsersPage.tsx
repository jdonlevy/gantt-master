import React, { useEffect, useState } from 'react';
import { AdminUser, fetchAdminUsers, updateUserRole, UserRole } from '../api';

const ROLE_OPTIONS: UserRole[] = ['viewer', 'editor', 'admin'];

export const AdminUsersPage: React.FC = () => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAdminUsers()
      .then((rows) => {
        if (!cancelled) setUsers(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load users');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRoleChange = async (user: AdminUser, role: UserRole) => {
    if (role === user.role) return;
    if (user.role === 'admin' && role !== 'admin') {
      const ok = window.confirm(
        `Demote ${user.displayName ?? user.email ?? user.id} from admin to ${role}?`
      );
      if (!ok) return;
    }
    const previous = user.role;
    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role } : u)));
    try {
      const updated = await updateUserRole(user.id, role);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? updated : u)));
    } catch (err) {
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: previous } : u)));
      const base = (err as Error).message || 'Failed to update role';
      setError(`${base}; reverted to ${previous}.`);
    }
  };

  if (loading) {
    return (
      <main className="page admin-page">
        <p>Loading…</p>
      </main>
    );
  }

  return (
    <main className="page admin-page">
      <h2>User roles</h2>
      <p className="muted">
        Admins manage user permissions. Editors can create and modify dashboards; viewers have read-only access.
      </p>
      {error && <div className="error-banner">{error}</div>}
      <table className="admin-users-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td>{user.displayName ?? '—'}</td>
              <td>{user.email ?? '—'}</td>
              <td>
                <select
                  value={user.role}
                  onChange={(event) => handleRoleChange(user, event.target.value as UserRole)}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </td>
              <td>{user.lastSeenAt ? new Date(user.lastSeenAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
};
