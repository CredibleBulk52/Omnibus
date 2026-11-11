import React from 'react';
import ReactDOM from 'react-dom/client';
import './components/appearance'; // apply the cached colours before the first paint
import './components/spreadCovers'; // wraparound covers show their front (right) half
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
