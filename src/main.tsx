import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App';
import SortingApp from './sorting/SortingApp';
import './ui/styles.css';

function Workspace() {
  const [hash, setHash] = React.useState(location.hash);
  React.useEffect(() => {
    const change = () => setHash(location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return hash === '#factory' ? <App /> : <SortingApp />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Workspace />
  </React.StrictMode>,
);
