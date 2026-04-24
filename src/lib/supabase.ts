import { createClient } from '@supabase/supabase-js';

// TODO: Replace with your projected Supabase URL and Anon Key
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'public-anon-key';

export const supabase = createClient(supabaseUrl, supabaseKey);

export async function verifyBarcode(barcode: string) {
    if (!barcode || barcode.trim() === '') return null;

    let baselineProductName = 'UNKNOWN';
    let brandName = 'N/A';
    let imageUrl = '';
    let category = 'N/A';
    let ingredients = 'N/A';
    let nutriScore = 'N/A';
    let novaGroup = 'N/A';
    let ecoScore = 'N/A';
    let ingredientsAnalysis: string[] = [];
    let nutrientLevels: Record<string, string> = {};
    let nutritionFacts: Record<string, any> = {};
    const is729 = barcode.startsWith('729');

    // 1. SUPABASE CHECK: Lookup in `products`
    try {
        const { data: productData } = await supabase
            .from('products')
            .select('*')
            .eq('barcode', barcode)
            .single();

        if (productData) {
            baselineProductName = productData.name || 'KNOWN PRODUCT';
            brandName = productData.brand || 'KNOWN BRAND';
            
            // If the DB explicitly flags it as Israeli or if it's a 729
            if (productData.is_israeli || is729) {
                return {
                    status: 'israeli',
                    source: productData.is_israeli ? 'SUPABASE DB' : 'SYSTEM',
                    reason: productData.is_israeli ? 'DB: FLAGGED AS ISRAELI' : 'PREFIX MATCH [729 : ISRAEL]',
                    productName: baselineProductName,
                    brandName,
                    imageUrl,
                    category,
                    ingredients,
                    nutriScore,
                    novaGroup,
                    ecoScore,
                    ingredientsAnalysis,
                    nutrientLevels,
                    nutritionFacts
                };
            }

            return {
                status: 'safe',
                source: 'SUPABASE DB',
                reason: 'DB: VERIFIED SAFE',
                productName: baselineProductName,
                brandName,
                imageUrl,
                category,
                ingredients,
                nutriScore,
                novaGroup,
                ecoScore,
                ingredientsAnalysis,
                nutrientLevels,
                nutritionFacts
            };
        }
    } catch(err) {
        console.error("Local DB fetch failed", err);
    }

    // 2. FALLBACK API: OpenFoodFacts v2
    try {
        const offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`, {
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'IsraelCheckerApp/1.0.0 (Android; Mobile)'
            }
        });
        const offData = await offRes.json();

        if (offData.status === 1 && offData.product) {
            const p = offData.product;
            const productName = p.product_name || p.product_name_en || p.generic_name || `UNKNOWN ITEM [${barcode}]`;
            
            // Extract extra details
            const rawBrands = p.brands || p.brand_owner || '';
            const brands = rawBrands ? rawBrands.split(',').map((b: string) => b.trim()) : [];
            brandName = brands.length > 0 ? brands[0] : 'UNKNOWN BRAND';
            imageUrl = p.image_url || p.image_front_url || '';
            
            // Clean up categories so it's not a massive comma-separated list
            category = p.categories ? p.categories.split(',').pop()?.replace('en:', '').trim() || 'N/A' : 'N/A';
            ingredients = p.ingredients_text || p.ingredients_text_en || 'N/A';

            // Elaborate details requested
            nutriScore = p.nutriscore_grade ? p.nutriscore_grade.toUpperCase() : 'N/A';
            novaGroup = p.nova_group ? String(p.nova_group) : 'N/A';
            ecoScore = p.ecoscore_grade ? p.ecoscore_grade.toUpperCase() : 'N/A';
            ingredientsAnalysis = p.ingredients_analysis_tags ? p.ingredients_analysis_tags.map((t: string) => t.replace('en:', '').replace(/-/g, ' ')) : [];
            nutrientLevels = p.nutrient_levels || {};
            nutritionFacts = p.nutriments || {};
            
            // 3. CROSS-REFERENCE: Match against `banned_brands`
            if (brands.length > 0) {
                const { data: brandData } = await supabase
                    .from('banned_brands')
                    .select('*')
                    .in('brand_name', brands);
                
                if (brandData && brandData.length > 0) {
                    return {
                        status: 'israeli',
                        source: 'API CROSS-REF',
                        reason: `BANNED BRAND DETECTED: [${brandData[0].brand_name}]`,
                        productName,
                        brandName,
                        imageUrl,
                        category,
                        ingredients,
                        nutriScore,
                        novaGroup,
                        ecoScore,
                        ingredientsAnalysis,
                        nutrientLevels,
                        nutritionFacts
                    };
                }
            }

            // Fallback checking origins tags if possible
            const origins = (p.origins || p.countries_tags || '').toLowerCase();
            if (origins.includes('israel') || origins.includes('en:israel')) {
                return { 
                    status: 'israeli', 
                    source: 'API TAGS',
                    reason: 'ORIGIN LABEL [ISRAEL] DETECTED', 
                    productName,
                    brandName,
                    imageUrl,
                    category,
                    ingredients,
                    nutriScore,
                    novaGroup,
                    ecoScore,
                    ingredientsAnalysis,
                    nutrientLevels,
                    nutritionFacts
                };
            }

            // Finally check the 729 prefix now that we have the product name
            if (is729) {
                return { 
                    status: 'israeli', 
                    source: 'SYSTEM + API',
                    reason: 'PREFIX MATCH [729 : ISRAEL]', 
                    productName,
                    brandName,
                    imageUrl,
                    category,
                    ingredients,
                    nutriScore,
                    novaGroup,
                    ecoScore,
                    ingredientsAnalysis,
                    nutrientLevels,
                    nutritionFacts
                };
            }

            return { 
                status: 'safe', 
                source: 'API VERIFICATION',
                reason: 'CLEARED BY OPEN_FOOD_FACTS', 
                productName,
                brandName,
                imageUrl,
                category,
                ingredients,
                nutriScore,
                novaGroup,
                ecoScore,
                ingredientsAnalysis,
                nutrientLevels,
                nutritionFacts
            };
        }
    } catch (e) {
        console.error("OFF API Error", e);
    }

    // 4. ABSOLUTE FALLBACK
    if (is729) {
         return { 
            status: 'israeli', 
            source: 'SYSTEM',
            reason: 'PREFIX MATCH [729 : ISRAEL]', 
            productName: 'UNKNOWN ITEM',
            brandName: 'N/A',
            imageUrl: '',
            category: 'N/A',
            ingredients: 'N/A',
            nutriScore: 'N/A',
            novaGroup: 'N/A',
            ecoScore: 'N/A',
            ingredientsAnalysis: [],
            nutrientLevels: {},
            nutritionFacts: {}
        };
    }

    return { 
        status: 'not_found', 
        source: 'GLOBAL SEARCH',
        reason: 'CODE NOT FOUND IN ANY DATABASE', 
        productName: 'UNKNOWN',
        brandName: 'N/A',
        imageUrl: '',
        category: 'N/A',
        ingredients: 'N/A',
        nutriScore: 'N/A',
        novaGroup: 'N/A',
        ecoScore: 'N/A',
        ingredientsAnalysis: [],
        nutrientLevels: {},
        nutritionFacts: {}
    };
}