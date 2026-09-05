import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardLayout from './pages/DashboardLayout';
import OverviewPage from './pages/OverviewPage';
import ScheduledPage from './pages/ScheduledPage';
import SentPage from './pages/SentPage';
import ComposePage from './pages/ComposePage';
import SlackPage from './pages/SlackPage';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/scheduled" element={<ScheduledPage />} />
            <Route path="/sent" element={<SentPage />} />
            <Route path="/compose" element={<ComposePage />} />
            <Route path="/slack" element={<SlackPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#1c2030',
              color: '#f1f3f9',
              border: '1px solid #2a2f42',
              borderRadius: '10px',
              fontSize: '0.875rem',
            },
            success: {
              iconTheme: { primary: '#22c55e', secondary: '#1c2030' },
            },
            error: {
              iconTheme: { primary: '#ef4444', secondary: '#1c2030' },
            },
          }}
        />
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
