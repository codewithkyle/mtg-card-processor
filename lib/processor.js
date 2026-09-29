const { frontHash, backHash, treatment, preferredPrint, illustrationId } = require("./hash");

function getCardImage(images){
    let image = null;
    if (images?.["png"]){
        image = images["png"];
    } else if (images?.["large"]){
        image = images["large"];
    } else if (images?.["normal"]){
        image = images["normal"];
    } else if (images?.["small"]){
        image = images["small"];
    } else if (images?.["border_crop"]){
        image = images["border_crop"];
    } else {
        image = images?.[Object.keys(images)?.[0]] ?? null;
    }
    return image;
}

function getArtCrop(images){
    let image = null;
    if (images?.["art_crop"]){
        image = images["art_crop"];
    }
    return image;
}

// Which image_uris a face renders from. Only the layouts that print two
// separate images read from card_faces; everything else - split, adventure,
// flip - puts both faces on one image held at the top level.
function faceImages(data, face){
    if (["modal_dfc", "transform"].includes(data?.["layout"])){
        return data?.["card_faces"]?.[face]?.["image_uris"] ?? {};
    }
    return data?.["image_uris"] ?? {};
}

function releasedInt(data){
    return +(data?.["released_at"] ?? "").replace(/-/g, "");
}

function buildCardData(data){
    const card = {
        oracleId: data["oracle_id"],
        date: data["released_at"],
        name: data["name"],
        layout: data["layout"],
        colors: data?.["colors"] || data?.["color_identity"] || [],
        legalities: data?.["legalities"] ?? [],
        rarity: data?.["rarity"] ?? null,
        keywords: data?.["keywords"] ?? [],
        type: null,
        subtypes: [],
        texts: [],
        manaCosts: [],
        totalManaCost: 0,
        faceNames: [],
        flavorTexts: [],
        toughness: 0,
        power: 0,
        art: null,
        price: null,
        tix: null,
        set: null,
        edhRank: null,
    };

    for (const legalitie in card.legalities){
        if (card.legalities[legalitie] === "legal"){
            card.legalities[legalitie] = true;
        } else {
            card.legalities[legalitie] = false;
        }
    }

    if (data?.["card_faces"]?.length){
        for (let i = 0; i < data["card_faces"].length; i++){
            if ("type_line" in data["card_faces"][i]){
                const types = data["card_faces"][i]?.["type_line"]?.split("—") ?? [];
                if (types.length){
                    if (!card.type){
                        card.type = types[0].trim();
                    }
                    for (let j = 1; j < types.length; j++){
                        card.subtypes.push(types[j].trim());
                    }
                }
            }
            if (data["card_faces"][i]?.["oracle_text"]){
                card.texts.push(data["card_faces"][i]["oracle_text"]);
            }
            if (data["card_faces"][i]?.["mana_cost"]){
                card.manaCosts.push(data["card_faces"][i]["mana_cost"]);
                if (i === 0){
                    const manaValues = data["card_faces"][i]["mana_cost"].match(/\d|R|U|B|G|W|S/g);
                    if (manaValues){
                        for (let j = 0; j < manaValues.length; j++){
                            const value = parseInt(manaValues[j]);
                            if (!isNaN(value)){
                                card.totalManaCost += value;
                            } else {
                                card.totalManaCost += 1;
                            }
                        }
                    }
                }
            }
            if (data["card_faces"][i]?.["name"]){
                card.faceNames.push(data["card_faces"][i]["name"]);
            }
            if (data["card_faces"][i]?.["flavor_text"]){
                card.flavorTexts.push(data["card_faces"][i]["flavor_text"]);
            }
            if (data["card_faces"][i]?.["toughness"] && data["card_faces"][i]?.["power"]){
                card.power = data["card_faces"][0]["power"];
                card.toughness = data["card_faces"][0]["toughness"];
            }
        }
    } else {
        if (data?.["oracle_text"]){
            card.texts.push(data["oracle_text"]);
        }
        if (data?.["mana_cost"]){
            card.manaCosts.push(data["mana_cost"]);
        }
        if (data?.["name"]){
            card.faceNames.push(data["name"]);
        }
        if (data?.["flavor_text"]){
            card.flavorTexts.push(data["flavor_text"]);
        }
        if (data?.["power"] && data?.["toughness"]){
            card.power = data["power"];
            card.toughness = data["toughness"];
        }
        const types = data?.["type_line"]?.split("—") ?? [];
        if (types.length){
            card.type = types[0].trim();
            for (let i = 1; i < types.length; i++){
                card.subtypes.push(types[i].trim());
            }
        }
        // Optional chained because a fair number of cards - lands, most
        // tokens - carry no mana cost at all, and reading match() off
        // undefined used to throw all the way out of phase 1.
        const manaValues = data?.["mana_cost"]?.match(/\d|R|U|B|G|W|S/g);
        if (manaValues){
            for (let i = 0; i < manaValues.length; i++){
                const value = parseInt(manaValues[i]);
                if (!isNaN(value)){
                    card.totalManaCost += value;
                } else {
                    card.totalManaCost += 1;
                }
            }
        }
    }

    card.art = getArtCrop(faceImages(data, 0));

    if (data?.["prices"]?.["usd"] !== null) {
        card.price = parseFloat(data?.["prices"]?.["usd"]) * 100;
    }
    if (data?.["prices"]?.["tix"] !== null) {
        card.tix = parseFloat(data?.["prices"]?.["tix"]) * 100;
    }

    if (data?.["set_name"]) {
        card.set = data["set_name"];
    }

    if (data?.["edhrec_rank"]) {
        card.edhRank = data["edhrec_rank"];
    }

    return card;
}

// One printing, reduced to what the later phases need: the digest that decides
// which image it shares, and the addresses of that image upstream.
function buildPrintData(data){
    return {
        id: data["id"],
        hash: frontHash(data),
        backHash: backHash(data),
        front: getCardImage(faceImages(data, 0)),
        back: backHash(data) === null ? null : getCardImage(faceImages(data, 1)),
        art: getArtCrop(faceImages(data, 0)),
        imageStatus: data?.["image_status"] ?? null,
        released: releasedInt(data),
        set: data?.["set"] ?? null,
        cn: data?.["collector_number"] ?? null,
        illustration: illustrationId(data, 0),
        treatment: treatment(data),
    };
}

// The cheapest of the price fields across every printing, which is what the
// application shows. Either side may be null - a printing with no price at all
// must not beat one that has one.
function cheaper(current, next){
    if (current === null) return next;
    if (next === null) return current;
    return Math.min(current, next);
}

// Folds one printing into the store, keyed by oracle id. Card level fields
// come from the newest printing, prices from the cheapest, and every printing
// is recorded against the digest of the image it shows - so a card ends up
// holding one entry per distinct look, each naming every print id behind it.
module.exports = (scryfallData, store) => {
    const print = buildPrintData(scryfallData);

    if (!print.front){
        return { skipped: `${scryfallData["name"]} (${print.id}) has no front image` };
    }

    const oracleId = scryfallData["oracle_id"];
    let entry = store.get(oracleId);
    if (!entry){
        entry = {
            card: buildCardData(scryfallData),
            // The look the card is shown as when nobody has picked a printing.
            // It tracks the card level fields, so both come from the newest
            // printing, which is what the previous importer settled on.
            defaultFront: print.hash,
            defaultBack: print.backHash,
            looks: new Map(),
        };
        store.set(oracleId, entry);
    } else {
        const card = buildCardData(scryfallData);
        const price = cheaper(entry.card.price, card.price);
        const tix = cheaper(entry.card.tix, card.tix);
        if (Date.parse(card.date) >= Date.parse(entry.card.date)){
            entry.card = card;
            entry.defaultFront = print.hash;
            entry.defaultBack = print.backHash;
        }
        entry.card.price = price;
        entry.card.tix = tix;
    }

    // Keyed on both faces, not just the front. Ten Ixalan transforming cards
    // were printed in two promo sets that share the front illustration and use
    // a different one on the back - Treasure Map // Treasure Cove is one - so
    // folding on the front alone would have thrown one of each pair's back
    // faces away. The two entries still name the same front image, and phase 2
    // only fetches it once because both resolve to one filename.
    const lookKey = `${print.hash}:${print.backHash ?? ""}`;

    const look = entry.looks.get(lookKey);
    if (!look){
        entry.looks.set(lookKey, { ...print, prints: [print.id] });
        return { look: "new" };
    }

    // Two printings that hash alike are the same picture, so only one of them
    // is ever downloaded. Which one is decided by scan quality rather than by
    // whichever happened to stream past first.
    const winner = preferredPrint(look, print);
    if (winner !== look){
        entry.looks.set(lookKey, { ...winner, prints: look.prints });
    }
    entry.looks.get(lookKey).prints.push(print.id);
    return { look: "folded" };
};

module.exports.buildCardData = buildCardData;
module.exports.buildPrintData = buildPrintData;
