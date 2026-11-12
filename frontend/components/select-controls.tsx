"use client";

import { useEffect } from 'react';
import { installSelectControls } from '../public/select-control.js';

export function SelectControls() {
  useEffect(() => installSelectControls(document), []);
  return null;
}
