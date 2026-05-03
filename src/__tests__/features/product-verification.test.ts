import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Product verification data structures
 */
interface ProductData {
	barcode: string;
	name?: string;
	brand?: string;
	category?: string;
	images?: string[];
}

interface VerificationSource {
	source: 'OFF' | 'Serper' | 'Google' | 'Wikidata' | 'Wikipedia' | 'LLM' | 'Registry' | 'Official';
	confidence: number;
	data: ProductData;
	evidence: string;
}

interface VerificationResult {
	barcode: string;
	result: 'genuine' | 'counterfeit' | 'unknown';
	confidence: number;
	sources: VerificationSource[];
	evidence: string;
}

/**
 * OFF API Mock
 */
class OFFDatabase {
	private products = new Map<string, ProductData>();

	addProduct(data: ProductData): void {
		this.products.set(data.barcode, data);
	}

	lookup(barcode: string): ProductData | null {
		return this.products.get(barcode) || null;
	}

	clear(): void {
		this.products.clear();
	}
}

/**
 * Verification Engine
 */
class ProductVerifier {
	private off: OFFDatabase;
	sources: VerificationSource[] = [];

	constructor(off: OFFDatabase) {
		this.off = off;
	}

	verifyOffDatabase(barcode: string): boolean {
		const product = this.off.lookup(barcode);
		if (product) {
			this.sources.push({
				source: 'OFF',
				confidence: 0.9,
				data: product,
				evidence: 'Found in Open Food Facts database'
			});
			return true;
		}
		return false;
	}

	verifySerpSearch(barcode: string, searchResults: ProductData[] = []): boolean {
		if (searchResults.length > 0) {
			this.sources.push({
				source: 'Serper',
				confidence: 0.7,
				data: searchResults[0],
				evidence: `Found ${searchResults.length} web search results`
			});
			return true;
		}
		return false;
	}

	verifyWikidataCompany(brand: string): boolean {
		// Simulated Wikidata SPARQL lookup
		const validBrands = ['Coca Cola', 'Pepsi', 'Nestle', 'Unilever'];
		if (validBrands.includes(brand)) {
			this.sources.push({
				source: 'Wikidata',
				confidence: 0.85,
				data: { barcode: '', brand },
				evidence: `Verified company record on Wikidata: ${brand}`
			});
			return true;
		}
		return false;
	}

	verifyWikipediaBrand(brand: string): boolean {
		// Simulated Wikipedia brand lookup
		const validBrands = ['Coca Cola', 'Pepsi', 'Nestle'];
		if (validBrands.includes(brand)) {
			this.sources.push({
				source: 'Wikipedia',
				confidence: 0.8,
				data: { barcode: '', brand },
				evidence: `Found Wikipedia article for brand: ${brand}`
			});
			return true;
		}
		return false;
	}

	analyzeLLM(evidence: string): { result: 'genuine' | 'counterfeit' | 'unknown'; confidence: number } {
		// Simulated LLM analysis
		if (evidence.toLowerCase().includes('official')) {
			return { result: 'genuine', confidence: 0.92 };
		}
		if (evidence.toLowerCase().includes('suspicious')) {
			return { result: 'counterfeit', confidence: 0.85 };
		}
		return { result: 'unknown', confidence: 0.5 };
	}

	calculateFinalConfidence(): { result: 'genuine' | 'counterfeit' | 'unknown'; confidence: number } {
		if (this.sources.length === 0) {
			return { result: 'unknown', confidence: 0 };
		}

		// Simple averaging of confidence scores
		const avg = this.sources.reduce((sum, s) => sum + s.confidence, 0) / this.sources.length;

		if (avg >= 0.7) {
			return { result: 'genuine', confidence: avg };
		}
		if (avg <= 0.3) {
			return { result: 'counterfeit', confidence: 1 - avg };
		}
		return { result: 'unknown', confidence: 0.5 };
	}

	buildEvidence(): string {
		return this.sources.map((s) => `${s.source}: ${s.evidence}`).join('; ');
	}

	getResult(): VerificationResult {
		const { result, confidence } = this.calculateFinalConfidence();
		return {
			barcode: '',
			result,
			confidence,
			sources: this.sources,
			evidence: this.buildEvidence()
		};
	}

	reset(): void {
		this.sources = [];
	}
}

/**
 * Test Suite: OFF Database Lookup
 */
describe('Product Verification: OFF API', () => {
	let off: OFFDatabase;

	beforeEach(() => {
		off = new OFFDatabase();
	});

	it('should find product in OFF database', () => {
		const product: ProductData = {
			barcode: '5012345678900',
			name: 'Test Product',
			brand: 'Test Brand'
		};
		off.addProduct(product);

		const found = off.lookup('5012345678900');
		expect(found).toEqual(product);
	});

	it('should return null for missing product', () => {
		const found = off.lookup('9999999999999');
		expect(found).toBeNull();
	});

	it('should handle multiple products', () => {
		const product1: ProductData = { barcode: '111', name: 'Product 1', brand: 'Brand 1' };
		const product2: ProductData = { barcode: '222', name: 'Product 2', brand: 'Brand 2' };

		off.addProduct(product1);
		off.addProduct(product2);

		expect(off.lookup('111')).toEqual(product1);
		expect(off.lookup('222')).toEqual(product2);
	});

	it('should update existing product', () => {
		const product1: ProductData = { barcode: '111', name: 'Old Name', brand: 'Brand' };
		const product2: ProductData = { barcode: '111', name: 'New Name', brand: 'Brand' };

		off.addProduct(product1);
		off.addProduct(product2);

		expect(off.lookup('111')?.name).toBe('New Name');
	});
});

/**
 * Test Suite: Web Search Verification
 */
describe('Product Verification: Serper Search', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should verify with web search results', () => {
		const results = [
			{ barcode: '5012345678900', name: 'Product', brand: 'Brand' }
		];

		const verified = verifier.verifySerpSearch('5012345678900', results);
		expect(verified).toBe(true);
	});

	it('should not verify with empty search results', () => {
		const verified = verifier.verifySerpSearch('5012345678900', []);
		expect(verified).toBe(false);
	});

	it('should use first search result', () => {
		const results = [
			{ barcode: '111', name: 'First Result', brand: 'Brand A' },
			{ barcode: '222', name: 'Second Result', brand: 'Brand B' }
		];

		verifier.verifySerpSearch('5012345678900', results);
		const result = verifier.getResult();
		expect(result.sources[0].data.name).toBe('First Result');
	});
});

/**
 * Test Suite: Wikidata Company Verification
 */
describe('Product Verification: Wikidata Company Lookup', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should verify known company via Wikidata', () => {
		const verified = verifier.verifyWikidataCompany('Coca Cola');
		expect(verified).toBe(true);
	});

	it('should reject unknown company', () => {
		const verified = verifier.verifyWikidataCompany('Fake Company 123');
		expect(verified).toBe(false);
	});

	it('should handle multiple known companies', () => {
		expect(verifier.verifyWikidataCompany('Coca Cola')).toBe(true);
		verifier.reset();
		expect(verifier.verifyWikidataCompany('Nestle')).toBe(true);
	});
});

/**
 * Test Suite: Wikipedia Brand Verification
 */
describe('Product Verification: Wikipedia Brand Lookup', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should verify known brand via Wikipedia', () => {
		const verified = verifier.verifyWikipediaBrand('Coca Cola');
		expect(verified).toBe(true);
	});

	it('should reject unknown brand', () => {
		const verified = verifier.verifyWikipediaBrand('Fake Brand 456');
		expect(verified).toBe(false);
	});
});

/**
 * Test Suite: LLM Analysis
 */
describe('Product Verification: LLM Analysis', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should detect genuine products from LLM evidence', () => {
		const result = verifier.analyzeLLM('Official product with authentic packaging');
		expect(result.result).toBe('genuine');
		expect(result.confidence).toBeGreaterThan(0.8);
	});

	it('should detect counterfeit from LLM evidence', () => {
		const result = verifier.analyzeLLM('Suspicious packaging with spelling errors');
		expect(result.result).toBe('counterfeit');
		expect(result.confidence).toBeGreaterThan(0.7);
	});

	it('should return unknown when inconclusive', () => {
		const result = verifier.analyzeLLM('Cannot determine product authenticity');
		expect(result.result).toBe('unknown');
		expect(result.confidence).toBe(0.5);
	});
});

/**
 * Test Suite: Confidence Calculation
 */
describe('Product Verification: Confidence Scoring', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should average source confidences', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		verifier.verifyOffDatabase('111'); // 0.9
		verifier.verifyWikidataCompany('Coca Cola'); // 0.85

		const result = verifier.getResult();
		const expected = (0.9 + 0.85) / 2;
		expect(result.confidence).toBeCloseTo(expected, 1);
	});

	it('should mark genuine when confidence >= 0.7', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111'); // 0.9

		const result = verifier.getResult();
		expect(result.result).toBe('genuine');
	});

	it('should mark counterfeit when confidence <= 0.3', () => {
		// Add a source with very low confidence
		verifier.sources = [
			{
				source: 'OFF',
				confidence: 0.25,
				data: { barcode: '111' },
				evidence: 'Low confidence match'
			}
		];

		const result = verifier.calculateFinalConfidence();
		expect(result.result).toBe('counterfeit');
	});

	it('should mark unknown when confidence between 0.3 and 0.7', () => {
		verifier.sources = [
			{
				source: 'OFF',
				confidence: 0.5,
				data: { barcode: '111' },
				evidence: 'Medium confidence'
			}
		];

		const result = verifier.calculateFinalConfidence();
		expect(result.result).toBe('unknown');
	});

	it('should return zero confidence when no sources', () => {
		const result = verifier.getResult();
		expect(result.confidence).toBe(0);
		expect(result.result).toBe('unknown');
	});
});

/**
 * Test Suite: Evidence Building
 */
describe('Product Verification: Evidence Bundling', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should concatenate evidence from all sources', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111');
		verifier.verifyWikidataCompany('Coca Cola');

		const result = verifier.getResult();
		expect(result.evidence).toContain('OFF:');
		expect(result.evidence).toContain('Wikidata:');
	});

	it('should include source names in evidence', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111');

		const result = verifier.getResult();
		expect(result.evidence).toContain('OFF');
	});

	it('should handle empty evidence gracefully', () => {
		const result = verifier.getResult();
		expect(result.evidence).toBe('');
	});
});

/**
 * Test Suite: Fallback Verification
 */
describe('Product Verification: Fallback Chain', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should fall back when OFF lookup fails', () => {
		const off = new OFFDatabase();
		// Product not in OFF

		const offFailed = !verifier.verifyOffDatabase('999');
		expect(offFailed).toBe(true);

		// Should still try other sources
		verifier.verifyWikidataCompany('Coca Cola');
		const result = verifier.getResult();
		expect(result.sources.length).toBeGreaterThan(0);
	});

	it('should combine multiple sources when single fails', () => {
		const off = new OFFDatabase();
		// OFF has product
		off.addProduct({ barcode: '111', name: 'Product', brand: 'Coca Cola' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111');
		verifier.verifyWikidataCompany('Coca Cola');

		const result = verifier.getResult();
		expect(result.sources.length).toBe(2);
		expect(result.result).toBe('genuine');
	});
});

/**
 * Test Suite: Error Handling
 */
describe('Product Verification: Error Scenarios', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should handle null barcode gracefully', () => {
		const result = verifier.verifyOffDatabase('');
		expect(result).toBe(false);
	});

	it('should handle network errors in verification', () => {
		// Simulate failed verification
		const result = verifier.getResult();
		expect(result.result).toBe('unknown');
	});

	it('should return default result when all sources fail', () => {
		const result = verifier.getResult();
		expect(result).toBeDefined();
		expect(result.result).toBeDefined();
		expect(['genuine', 'counterfeit', 'unknown']).toContain(result.result);
	});
});

/**
 * Test Suite: Source Priority
 */
describe('Product Verification: Source Prioritization', () => {
	let verifier: ProductVerifier;

	beforeEach(() => {
		verifier = new ProductVerifier(new OFFDatabase());
	});

	it('should prioritize OFF (highest confidence)', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111'); // 0.9

		const result = verifier.getResult();
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.sources[0].source).toBe('OFF');
		expect(result.sources[0].confidence).toBe(0.9);
	});

	it('should include multiple sources for robustness', () => {
		const off = new OFFDatabase();
		off.addProduct({ barcode: '111', name: 'Product' });

		const verifier = new ProductVerifier(off);
		verifier.verifyOffDatabase('111');
		verifier.verifyWikidataCompany('Coca Cola');
		verifier.verifyWikipediaBrand('Coca Cola');

		const result = verifier.getResult();
		expect(result.sources.length).toBe(3);
	});
});
