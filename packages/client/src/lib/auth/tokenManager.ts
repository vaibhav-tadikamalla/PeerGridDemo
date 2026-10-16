import { apiUrl } from '@/lib/runtimeConfig';

interface TokenState {
  accessToken: string | null;
  expiresAt: number | null;
  isRefreshing: boolean;
}

type Listener = () => void;

async function safeJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await response.text().catch(() => '');
    throw new Error(`Server returned non-JSON response: ${response.status} ${response.statusText}`);
  }
  try {
    return await response.json() as T;
  } catch (err) {
    throw new Error('Failed to parse JSON response from server');
  }
}

class TokenManager {
  private state: TokenState = {
    accessToken: null,
    expiresAt: null,
    isRefreshing: false,
  };

  private listeners = new Set<Listener>();
  private refreshPromise: Promise<void> | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): TokenState {
    return this.state;
  }

  setToken(accessToken: string, expiresAt: number): void {
    this.state = { accessToken, expiresAt, isRefreshing: false };
    this.notifyListeners();
  }

  clearToken(): void {
    this.state = { accessToken: null, expiresAt: null, isRefreshing: false };
    this.notifyListeners();
  }

  isExpired(): boolean {
    if (!this.state.expiresAt) return true;
    return Date.now() / 1000 > this.state.expiresAt - 30;
  }

  async getValidToken(): Promise<string | null> {
    if (!this.state.accessToken) return null;
    if (!this.isExpired()) return this.state.accessToken;

    await this.refresh();
    return this.state.accessToken;
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.state = { ...this.state, isRefreshing: true };
    this.notifyListeners();

    this.refreshPromise = this._doRefresh().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async _doRefresh(): Promise<void> {
    try {
      const response = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Refresh failed');
      }

      const data = await safeJson<{ accessToken: string; expiresAt: number }>(response);
      this.setToken(data.accessToken, data.expiresAt);
    } catch {
      this.clearToken();
    }
  }

  async login(email: string, password: string): Promise<{
    user: { id: string; email: string; displayName: string; avatarUrl?: string };
  }> {
    let response: Response;
    try {
      response = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch (err: any) {
      throw new Error(`Network error during login: ${err.message}`);
    }

    if (!response.ok) {
      let message = 'Login failed';
      try {
        const errData = await safeJson<{ message?: string; error?: string }>(response);
        message = errData.message || errData.error || message;
      } catch (e) {
        message = `Login failed (${response.status} ${response.statusText})`;
      }
      throw new Error(message);
    }

    const data = await safeJson<{
      accessToken: string;
      expiresAt: number;
      user: { id: string; email: string; displayName: string; avatarUrl?: string };
    }>(response);

    this.setToken(data.accessToken, data.expiresAt);
    return { user: data.user };
  }

  async register(email: string, password: string, name: string): Promise<{
    user: { id: string; email: string; displayName: string };
  }> {
    let response: Response;
    try {
      response = await fetch(apiUrl('/api/auth/register'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name }),
      });
    } catch (err: any) {
      throw new Error(`Network error during registration: ${err.message}`);
    }

    if (!response.ok) {
      let message = 'Registration failed';
      try {
        const errData = await safeJson<{ message?: string; error?: string }>(response);
        message = errData.message || errData.error || message;
      } catch (e) {
        message = `Registration failed (${response.status} ${response.statusText})`;
      }
      throw new Error(message);
    }

    const data = await safeJson<{
      accessToken: string;
      expiresAt: number;
      user: { id: string; email: string; displayName: string };
    }>(response);

    this.setToken(data.accessToken, data.expiresAt);
    return { user: data.user };
  }

  async logout(): Promise<void> {
    try {
      await fetch(apiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'include',
        headers: this.state.accessToken
          ? { Authorization: `Bearer ${this.state.accessToken}` }
          : {},
      });
    } catch {
      // ignore logout network errors
    } finally {
      this.clearToken();
    }
  }

  async deleteAccount(password: string): Promise<void> {
    const response = await fetch(apiUrl('/api/auth/account'), {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(this.state.accessToken
          ? { Authorization: `Bearer ${this.state.accessToken}` }
          : {}),
      },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      let message = 'Failed to delete account';
      try {
        const errData = await safeJson<{ message?: string; error?: string }>(response);
        message = errData.message || errData.error || message;
      } catch (e) {
        message = `Delete failed (${response.status})`;
      }
      throw new Error(message);
    }

    this.clearToken();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const tokenManager = new TokenManager();
