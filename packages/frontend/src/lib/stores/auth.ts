import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export interface User {
  id: string;
  email: string;
  name: string;
  is_admin?: boolean;
  disabled?: boolean;
  createdAt?: Date;
  lastLogin?: Date | null;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
}

const STORAGE_KEY = 'logtide_auth';

function isValidStoredAuth(data: unknown): data is { user: User; token: string } {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as { user?: unknown; token?: unknown };
  if (typeof candidate.token !== 'string') {
    return false;
  }
  const user = candidate.user;
  if (typeof user !== 'object' || user === null) {
    return false;
  }
  const u = user as { id?: unknown; email?: unknown; name?: unknown };
  return (
    typeof u.id === 'string' &&
    typeof u.email === 'string' &&
    typeof u.name === 'string'
  );
}

function loadInitialState(): AuthState {
  if (browser) {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        if (isValidStoredAuth(data)) {
          return {
            user: data.user,
            token: data.token,
            loading: false,
          };
        }
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      console.error('Failed to load auth state:', e);
    }
  }

  return {
    user: null,
    token: null,
    loading: false,
  };
}

function createAuthStore() {
  const { subscribe, set, update } = writable<AuthState>(loadInitialState());

  return {
    subscribe,
    setAuth: (user: User, token: string) => {
      const state = { user, token, loading: false };

      if (browser) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }

      set(state);
    },
    updateUser: (user: User) => {
      update((state) => {
        const newState = { ...state, user };

        if (browser) {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(newState));
        }

        return newState;
      });
    },
    clearAuth: () => {
      if (browser) {
        localStorage.removeItem(STORAGE_KEY);
      }

      set({ user: null, token: null, loading: false });
    },
    setLoading: (loading: boolean) => {
      update((state) => ({ ...state, loading }));
    },
  };
}

export const authStore = createAuthStore();
