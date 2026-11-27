import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { request, type Session } from '../api.js';
import s from '../App.module.css';
import { ErrorBox } from '../components/Common.js';

export function Login({ onLogin, error }: { onLogin(value: Session): void; error: unknown }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => request<Session>('/auth/login', 'POST', { username, password }),
    onSuccess: onLogin,
  });

  return (
    <main className={s.login}>
      <form className={s.loginCard} onSubmit={(event) => { event.preventDefault(); login.mutate(); }}>
        <div className={s.mark}>R</div>
        <div className={s.eyebrow}>DSH REVIEW CENTER</div>
        <h1>让每一次修改<br />都有据可审。</h1>
        <p>登录中央工作台，查看项目、审查与执行状态。</p>
        <label>账号<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label>密码<input autoComplete="current-password" type="password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <ErrorBox error={login.error ?? error} />
        <button className={s.primary} disabled={login.isPending}>{login.isPending ? '正在登录…' : '登录工作台 →'}</button>
        <small>账号由管理员在中央服务创建。</small>
      </form>
    </main>
  );
}
