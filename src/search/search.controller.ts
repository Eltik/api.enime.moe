import { BadRequestException, CacheTTL, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import DatabaseService from '../database/database.service';
import { Throttle } from '@nestjs/throttler';
import { createPaginator } from 'prisma-pagination';
import { PaginateFunction } from 'prisma-pagination/src';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import Anime from '../entity/anime.entity';
import { Prisma } from '@prisma/client';
import Search from '../entity/search.entity';

@Controller("/search")
@ApiTags("search")
export default class SearchController {
    searchPaginator: PaginateFunction = undefined;

    constructor(@Inject("DATABASE") private readonly databaseService: DatabaseService) {
        this.searchPaginator = createPaginator({ })
    }

    @Get(":query")
    @CacheTTL(300)
    @Throttle(90, 60)
    @ApiOperation({ operationId: "Search Anime", summary: "Search anime based on query" })
    @ApiResponse({
        status: 200,
        description: "The list of anime matched from search query",
        type: Search
    })
    @ApiResponse({
        status: 429,
        description: "The API throttling has been reached, check response headers for more information"
    })
    @ApiQuery({
        type: Number,
        name: "page",
        required: false,
        description: "The page number of search list, default to 1"
    })
    @ApiQuery({
        type: Number,
        name: "perPage",
        required: false,
        description: "How many elements per page should this response have? Minimum: 1, maximum: 100"
    })
    @ApiQuery({
        type: Boolean,
        name: "all",
        required: false,
        description: "Whether the search query should include all anime (including ones that aren't released yet)"
    })
    async search(@Param("query") query: string, @Query("page") page: number, @Query("perPage") perPage: number, @Query("all") all: boolean) {
        if (query.length <= 1) throw new BadRequestException("The search query has to be greater than or equal to 2.");

        if (!page || page <= 0) page = 1;
        if (!perPage || perPage <= 0) perPage = 20;
        perPage = Math.min(100, perPage);

        query = query.replaceAll("-", "%").replaceAll(" ", "%");

        // See https://www.prisma.io/docs/concepts/components/prisma-client/raw-database-access#sql-injection, Prisma mitigates potential SQL injections already
        const skip = page > 0 ? perPage * (page - 1) : 0;

        const where = Prisma.sql`
            WHERE
            ${all ? Prisma.empty : Prisma.sql`(anime.status != 'NOT_YET_RELEASED') AND ("lastEpisodeUpdate" is not null) AND`}
            (
                ${"%" + query + "%"}        ILIKE ANY(synonyms)
                OR  ${"%" + query + "%"}    % ANY(synonyms)
                OR  anime.title->>'english' ILIKE ${"%" + query + "%"}
                OR  anime.title->>'romaji'  ILIKE ${"%" + query + "%"}
                OR  anime.title->>'native'  ILIKE ${"%" + query + "%"}
            )
        `;

        const [count, results] = await this.databaseService.$transaction([
            this.databaseService.$queryRaw`
                SELECT COUNT(*) FROM anime
                ${where}
            `,
            this.databaseService.$queryRaw`
                SELECT * FROM anime
                ${where}
                ORDER BY
                    (CASE WHEN anime.title->>'english' IS NOT NULL THEN similarity(LOWER(anime.title->>'english'), LOWER(${query})) ELSE 0 END,
                    + CASE WHEN anime.title->>'romaji' IS NOT NULL THEN similarity(LOWER(anime.title->>'romaji'), LOWER(${query})) ELSE 0 END,
                    + CASE WHEN anime.title->>'native' IS NOT NULL THEN similarity(LOWER(anime.title->>'native'), LOWER(${query})) ELSE 0 END,
                    + CASE WHEN synonyms IS NOT NULL THEN most_similar(LOWER(${query}), synonyms) ELSE 0 END)
                        DESC
                LIMIT    ${perPage}
                OFFSET   ${skip}
            `
        ])

        const total: number = Number(count[0].count);
        const lastPage = Math.ceil(Number(total) / perPage)

        for (let result of results) {
            const genreIds: string[] = ((await this.databaseService.$queryRaw`
            SELECT * FROM "_AnimeToGenre" WHERE "A" = ${result.id}
            `) as object[]).map(relation => relation["B"]);

            const genres = await this.databaseService.$transaction(genreIds.map(id => this.databaseService.genre.findUnique({ where: { id } })));

            result.genre = genres.map(genre => genre.name);
        }

        return {
            data: results,
            meta: {
                total: total,
                lastPage,
                currentPage: Number(page),
                perPage,
                prev: page > 1 ? page - 1 : null,
                next: page < lastPage ? page + 1 : null,
            },
        }
    }
}
