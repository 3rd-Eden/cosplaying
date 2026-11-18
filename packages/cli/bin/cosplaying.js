#!/usr/bin/env node
import { cosplaying } from '../src/main.js';

const code = await cosplaying();
process.exit(code);
