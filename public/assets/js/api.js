// /assets/js/api.js — Cliente HTTP para o backend PMI
(function (window) {
  'use strict';

  const API_BASE = '/api';

  async function request(method, path, body = null, opts = {}) {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const init = {
      method,
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
      ...opts,
    };
    if (body && method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res, data;
    try {
      res = await fetch(url, init);
      const text = await res.text();
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { raw: text }; }
    } catch (e) {
      throw new ApiError(0, 'Falha de rede', { network: true });
    }
    if (!res.ok) {
      throw new ApiError(res.status, data.error || `Erro ${res.status}`, data);
    }
    return data;
  }

  class ApiError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
      this.name = 'ApiError';
    }
  }

  const api = {
    error: ApiError,

    auth: {
      signup:  (data) => request('POST', '/auth/signup', data),
      login:   (data) => request('POST', '/auth/login', data),
      logout:  ()     => request('POST', '/auth/logout'),
      me:      ()     => request('GET',  '/auth/me'),
      changePassword: (current, next) => request('POST', '/auth/change-password',
                          { currentPassword: current, newPassword: next }),
    },

    instagram: {
      connect:    (token)   => request('POST',   '/instagram/connect', { accessToken: token }),
      list:       ()        => request('GET',    '/instagram/accounts'),
      remove:     (id)      => request('DELETE', `/instagram/accounts/${id}`),
      setPrimary: (id)      => request('POST',   `/instagram/accounts/${id}/primary`),
      sync:       (id)      => request('POST',   `/instagram/accounts/${id}/sync`),
    },

    posts: {
      list:    (params = {}) => request('GET', '/posts?' + new URLSearchParams(params)),
      create:  (data)        => request('POST',   '/posts', data),
      update:  (id, data)    => request('PATCH',  `/posts/${id}`, data),
      remove:  (id)          => request('DELETE', `/posts/${id}`),
      approve: (id)          => request('POST',   `/posts/${id}/approve`),
      reject:  (id, reason)  => request('POST',   `/posts/${id}/reject`, { reason }),
      publish: (data)        => request('POST',   '/posts/publish', data),
      comments:(mediaId)     => request('GET',    `/posts/${mediaId}/comments`),
      reply:   (commentId, message) => request('POST', `/posts/comments/${commentId}/reply`, { message }),
    },

    insights: {
      overview: (params = {}) => request('GET', '/insights/overview?' + new URLSearchParams(params)),
      audience: (params = {}) => request('GET', '/insights/audience?' + new URLSearchParams(params)),
      post:     (mediaId, params = {}) => request('GET', `/insights/post/${mediaId}?` + new URLSearchParams(params)),
    },

    inbox: {
      list:    () => request('GET', '/inbox'),
      replyDm: (recipientId, message) => request('POST', '/inbox/reply-dm', { recipientId, message }),
    },

    ai: {
      caption:  (data) => request('POST', '/ai/caption',  data),
      hashtags: (data) => request('POST', '/ai/hashtags', data),
    },

    users: {
      list:   ()         => request('GET',    '/users'),
      create: (data)     => request('POST',   '/users', data),
      update: (id, data) => request('PATCH',  `/users/${id}`, data),
      remove: (id)       => request('DELETE', `/users/${id}`),
    },

    health: () => request('GET', '/health'),
  };

  window.api = api;
})(window);
