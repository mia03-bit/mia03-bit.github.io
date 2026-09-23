import { useEffect } from 'react';
import { AppRoutes } from '../routes/AppRoutes';


export default function AdminOverviewRedirect() {
  useEffect(() => {
    // placeholder: when real router/auth is wired, this can be removed
  }, []);

  // Keep it simple: always show overview for now
  return <AppRoutes />;
}

