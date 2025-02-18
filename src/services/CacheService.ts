import fs from 'fs';
import path from 'path';
import { BigNumber } from 'ethers';
import logger from '../utils/logger';

export interface CachedMarketData {
  volume?: {
    value: string; // BigNumber serialized
    timestamp: number;
  };
  marketCap?: {
    value: string; // BigNumber serialized
    timestamp: number;
  };
  liquidity?: {
    value: string; // BigNumber serialized
    timestamp: number;
  };
}

export interface MarketCacheData {
  [key: string]: CachedMarketData;
}

export class CacheService {
  private cacheFilePath: string;
  private cache: MarketCacheData = {};
  private readonly CACHE_FILE_NAME = 'market_cache.json';
  private saveTimeout: NodeJS.Timeout | null = null;
  private readonly SAVE_DELAY = 5000; // 5 seconds debounce

  constructor(rootDir: string = process.cwd()) {
    const cacheDir = path.join(rootDir, 'cache');
    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    this.cacheFilePath = path.join(cacheDir, this.CACHE_FILE_NAME);
    logger.info('Initializing cache service', {
      cacheDir,
      cacheFile: this.cacheFilePath
    });
    this.loadCache();
  }

  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        const data = fs.readFileSync(this.cacheFilePath, 'utf8');
        this.cache = JSON.parse(data);
        logger.info('Cache loaded successfully', {
          entries: Object.keys(this.cache).length
        });
      }
    } catch (error) {
      logger.error('Error loading cache', { error: error as Error });
      this.cache = {};
    }
  }

  private debouncedSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.cache, null, 2));
        logger.info('Cache saved successfully', {
          entries: Object.keys(this.cache).length
        });
      } catch (error) {
        logger.error('Error saving cache', { error: error as Error });
      }
    }, this.SAVE_DELAY);
  }

  public get(key: string): CachedMarketData | undefined {
    return this.cache[key];
  }

  public set(key: string, data: CachedMarketData): void {
    this.cache[key] = data;
    this.debouncedSave();
  }

  public update(key: string, data: Partial<CachedMarketData>): void {
    this.cache[key] = {
      ...this.cache[key],
      ...data
    };
    this.debouncedSave();
  }

  public deserializeBigNumber(value: string | undefined): BigNumber | undefined {
    if (!value) return undefined;
    try {
      return BigNumber.from(value);
    } catch (error) {
      logger.error('Error deserializing BigNumber', { value, error: error as Error });
      return undefined;
    }
  }

  public serializeBigNumber(value: BigNumber | undefined): string | undefined {
    if (!value) return undefined;
    return value.toString();
  }
} 